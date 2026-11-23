// Fetching a client document without the network: the addresses refused, one refused address
// among several refusing the host, the connection going to the address checked (DNS pinning),
// redirects not followed, the size limit. The resolver and the HTTPS request are the test's.

import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { CLIENT_DOCUMENT_MAX_BYTES, ClientError } from "@fluxvita/saveslot-service";
import { describe, expect, it } from "vitest";
import { addressRefused, clientFetcher, type Resolve } from "./fetch.ts";

const URL_ = new URL("https://client.example/oauth/client.json");

/** A resolver answering `answers` in turn, counting its calls. */
function resolver(...answers: string[][]): Resolve & { calls: number } {
  const r = async () => {
    const a = answers[Math.min(r.calls, answers.length - 1)] ?? [];
    r.calls++;
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  r.calls = 0;
  return r;
}

interface Seen {
  host?: string;
  servername?: string;
  connectedTo?: string;
}

/** An HTTPS request that answers `status`, `headers` and `body`, and records where it connected. */
function fakeRequest(
  seen: Seen,
  answer: { status?: number; headers?: Record<string, string>; body?: Buffer } = {},
): typeof httpsRequest {
  return ((options: Record<string, unknown>, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void };
    seen.host = options["host"] as string;
    const servername = options["servername"] as string | undefined;
    if (servername !== undefined) seen.servername = servername;
    req.destroy = () => {};
    req.end = () => {
      // How node:https would connect: through the request's lookup.
      const lookup = options["lookup"] as (
        name: string,
        o: object,
        done: (e: null, address: string) => void,
      ) => void;
      lookup(seen.host as string, {}, (_e, address) => {
        seen.connectedTo = address;
        const res = Readable.from([answer.body ?? Buffer.from("{}")]) as Readable & {
          statusCode: number;
          headers: Record<string, string>;
        };
        res.statusCode = answer.status ?? 200;
        res.headers = answer.headers ?? {};
        cb(res);
      });
    };
    return req;
  }) as unknown as typeof httpsRequest;
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ClientError) return e.code;
    throw e;
  }
  return "fetched";
}

describe("refused addresses", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "::ffff:a00:1",
    "::127.0.0.1",
    "64:ff9b::a00:1",
    "2002:a00:1::",
    "3fff::1",
    "3fff:fff:ffff::1",
    "5f00::1",
    "5f00:ffff::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "not an address",
  ])("%s", (a) => {
    expect(addressRefused(a)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "93.184.215.14",
    "172.32.0.1",
    "2606:4700::1111",
    "2a00:1450::1",
    // Just past the documentation and segment routing ranges.
    "3fff:1000::1",
    "5f01::1",
  ])("public: %s", (a) => {
    expect(addressRefused(a)).toBe(false);
  });
});

describe("client fetcher", () => {
  it("connects to the address it checked, the TLS name being the host's", async () => {
    const seen: Seen = {};
    // A second lookup would answer inside: there must be none.
    const resolve = resolver(["93.184.215.14"], ["127.0.0.1"]);
    const doc = await clientFetcher({
      resolve,
      request: fakeRequest(seen, { headers: { "cache-control": "max-age=60" } }),
    })(URL_);
    expect(seen).toEqual({
      host: "client.example",
      servername: "client.example",
      connectedTo: "93.184.215.14",
    });
    expect(resolve.calls).toBe(1);
    expect(doc).toEqual({ body: new Uint8Array(Buffer.from("{}")), cacheControl: "max-age=60" });
  });

  it.each([
    ["a private address", [["10.0.0.5"]]],
    ["the loopback", [["127.0.0.1"]]],
    ["an IPv4-mapped IPv6 address", [["::ffff:93.184.215.14"]]],
    ["one private among public ones", [["93.184.215.14", "192.168.0.10"]]],
  ])("a host resolving to %s: refused, nothing requested", async (_, answers) => {
    const seen: Seen = {};
    expect(
      await code(
        clientFetcher({ resolve: resolver(...answers), request: fakeRequest(seen) })(URL_),
      ),
    ).toBe("address_refused");
    expect(seen).toEqual({});
  });

  it("an IP literal in the URL is checked as it is", async () => {
    const seen: Seen = {};
    expect(
      await code(
        clientFetcher({ resolve: resolver(), request: fakeRequest(seen) })(
          new URL("https://[::1]/c.json"),
        ),
      ),
    ).toBe("address_refused");
    expect(seen).toEqual({});
  });

  it("no address, or a resolver that fails: fetch_failed", async () => {
    expect(
      await code(clientFetcher({ resolve: resolver([]), request: fakeRequest({}) })(URL_)),
    ).toBe("fetch_failed");
    expect(
      await code(
        clientFetcher({
          resolve: async () => {
            throw new Error("NXDOMAIN");
          },
          request: fakeRequest({}),
        })(URL_),
      ),
    ).toBe("fetch_failed");
  });

  it("a resolver slower than the time limit: fetch_failed", async () => {
    const slow: Resolve = () => new Promise(() => {});
    expect(
      await code(clientFetcher({ resolve: slow, request: fakeRequest({}), timeoutMs: 50 })(URL_)),
    ).toBe("fetch_failed");
  });

  it.each([301, 302, 307, 308, 404, 500])(
    "answered %i: fetch_failed, no redirect followed",
    async (status) => {
      expect(
        await code(
          clientFetcher({
            resolve: resolver(["93.184.215.14"]),
            request: fakeRequest({}, { status, headers: { location: "https://127.0.0.1/" } }),
          })(URL_),
        ),
      ).toBe("fetch_failed");
    },
  );

  it("one byte past the limit: document_too_large", async () => {
    const big = Buffer.alloc(CLIENT_DOCUMENT_MAX_BYTES + 1, 0x20);
    expect(
      await code(
        clientFetcher({
          resolve: resolver(["93.184.215.14"]),
          request: fakeRequest({}, { body: big }),
        })(URL_),
      ),
    ).toBe("document_too_large");
    const exact = Buffer.alloc(CLIENT_DOCUMENT_MAX_BYTES, 0x20);
    expect(
      await code(
        clientFetcher({
          resolve: resolver(["93.184.215.14"]),
          request: fakeRequest({}, { body: exact }),
        })(URL_),
      ),
    ).toBe("fetched");
  });

  it("plain HTTP: refused before anything", async () => {
    const resolve = resolver(["93.184.215.14"]);
    expect(
      await code(
        clientFetcher({ resolve, request: fakeRequest({}) })(new URL("http://client.example/c")),
      ),
    ).toBe("fetch_failed");
    expect(resolve.calls).toBe(0);
  });
});
