// Where a request comes from (02-architecture §5 «身份»): the connection's address unless it is a
// trusted proxy's; then X-Forwarded-For from the right, past the trusted proxies, the leftmost when
// all are trusted; a client's own header counts for nothing; addresses in one written form.
// Documentation addresses only (RFC 5737, RFC 3849).

import { describe, expect, it } from "vitest";
import { normalizeAddress, requestSource } from "./request-source.ts";

const PROXY = "192.0.2.10";
const PROXY2 = "192.0.2.11";
const CLIENT = "198.51.100.7";
const trusted = new Set([PROXY, PROXY2]);

describe("the request's source", () => {
  it("no trusted proxies configured: the connection's address, whatever the header says", () => {
    expect(
      requestSource({ connection: CLIENT, forwardedFor: "203.0.113.9", trusted: new Set() }),
    ).toBe(CLIENT);
  });

  it("a connection from a trusted proxy: the header's first address from the right that is not a proxy", () => {
    expect(requestSource({ connection: PROXY, forwardedFor: CLIENT, trusted })).toBe(CLIENT);
    // What the client put in front is not read past the first address that is not a proxy.
    expect(
      requestSource({
        connection: PROXY,
        forwardedFor: `203.0.113.9, ${CLIENT}, ${PROXY2}`,
        trusted,
      }),
    ).toBe(CLIENT);
    // Several headers are one list, in order.
    expect(
      requestSource({
        connection: PROXY,
        forwardedFor: ["203.0.113.9", `${CLIENT}, ${PROXY2}`],
        trusted,
      }),
    ).toBe(CLIENT);
  });

  it("a connection not from a trusted proxy: the header is not read at all", () => {
    expect(requestSource({ connection: CLIENT, forwardedFor: "203.0.113.9", trusted })).toBe(
      CLIENT,
    );
  });

  it("every address in the header a trusted proxy: the leftmost", () => {
    expect(requestSource({ connection: PROXY, forwardedFor: `${PROXY2}, ${PROXY}`, trusted })).toBe(
      PROXY2,
    );
  });

  it("an entry the client wrote that is no address ends nothing: the walk stops at it, the source is right of it", () => {
    // The client wrote "x"; the trusted proxy appended the address it was reached from.
    expect(requestSource({ connection: PROXY, forwardedFor: `x, ${CLIENT}`, trusted })).toBe(
      CLIENT,
    );
    expect(requestSource({ connection: PROXY, forwardedFor: `x, ${PROXY2}`, trusted })).toBe(
      PROXY2,
    );
    expect(
      requestSource({
        connection: PROXY,
        forwardedFor: ["unknown", `${CLIENT}, ${PROXY2}`],
        trusted,
      }),
    ).toBe(CLIENT);
  });

  it("the rightmost entry no address (a proxy that wrote a port), or none at all: the connection's address", () => {
    expect(requestSource({ connection: PROXY, forwardedFor: undefined, trusted })).toBe(PROXY);
    expect(requestSource({ connection: PROXY, forwardedFor: "unknown", trusted })).toBe(PROXY);
    expect(requestSource({ connection: PROXY, forwardedFor: `${CLIENT}:4711`, trusted })).toBe(
      PROXY,
    );
    expect(requestSource({ connection: PROXY, forwardedFor: `${CLIENT},`, trusted })).toBe(PROXY);
  });

  it("a connection with no single usable address (a unix socket, a link-local address with a zone): none", () => {
    expect(requestSource({ connection: undefined, forwardedFor: CLIENT, trusted })).toBeUndefined();
    expect(
      requestSource({ connection: "fe80::1%en0", forwardedFor: CLIENT, trusted }),
    ).toBeUndefined();
  });

  it("an IPv4 connection written as IPv6 is the IPv4 address, trusted as such", () => {
    expect(requestSource({ connection: `::ffff:${PROXY}`, forwardedFor: CLIENT, trusted })).toBe(
      CLIENT,
    );
  });
});

describe("an address in one written form", () => {
  it.each([
    ["192.0.2.1", "192.0.2.1"],
    [" 192.0.2.1 ", "192.0.2.1"],
    ["::ffff:192.0.2.1", "192.0.2.1"],
    ["::FFFF:C000:0201", "192.0.2.1"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
  ])("%s is %s", (text, form) => {
    expect(normalizeAddress(text)).toBe(form);
  });

  it.each([
    ["192.0.2.1:80"],
    ["192.0.2.0/24"],
    ["fe80::1%en0"],
    ["example.org"],
    [""],
    ["unknown"],
  ])("%s is no address", (text) => {
    expect(normalizeAddress(text)).toBeUndefined();
  });
});
