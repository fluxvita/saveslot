// Where a request comes from (02-architecture §5 «身份»): the connection's address unless it is a
// trusted proxy's; then X-Forwarded-For from the right, past the trusted proxies, the leftmost when
// all are trusted; a client's own header counts for nothing; addresses in one written form.
// The trusted proxies are single addresses and CIDR ranges: "trusted" is "inside one of them".
// Documentation addresses only (RFC 5737, RFC 3849, RFC 9637).

import { describe, expect, it } from "vitest";
import {
  normalizeAddress,
  parseProxyEntry,
  requestSource,
  trustedProxies,
} from "./request-source.ts";

const PROXY = "192.0.2.10";
const PROXY2 = "192.0.2.11";
const CLIENT = "198.51.100.7";
const trusted = trustedProxies([PROXY, PROXY2]);

describe("the request's source", () => {
  it("no trusted proxies configured: the connection's address, whatever the header says", () => {
    expect(
      requestSource({
        connection: CLIENT,
        forwardedFor: "203.0.113.9",
        trusted: trustedProxies([]),
      }),
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

describe("the trusted proxies' type", () => {
  it("only trustedProxies makes one: a set of strings, compared as written, does not type-check", () => {
    const strings = new Set(["192.0.2.0/24"]);
    const source = requestSource({
      connection: "192.0.2.1",
      forwardedFor: CLIENT,
      // @ts-expect-error a Set has a `has`, but would lose the ranges
      trusted: strings,
    });
    // What it would have done: the range not matched, the header not read.
    expect(source).toBe("192.0.2.1");
    expect(
      requestSource({
        connection: "192.0.2.1",
        forwardedFor: CLIENT,
        trusted: trustedProxies(["192.0.2.0/24"]),
      }),
    ).toBe(CLIENT);
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

/** Whether `address` is trusted by a list of one entry. */
const inside = (entry: string, address: string): boolean => trustedProxies([entry]).has(address);

describe("a trusted proxy range", () => {
  it.each([
    // Both ends of the range in, the addresses next to them out.
    ["192.0.2.0/24", ["192.0.2.0", "192.0.2.255"], ["192.0.1.255", "192.0.3.0"]],
    // Prefixes off a byte's edge.
    ["198.51.100.128/25", ["198.51.100.128", "198.51.100.255"], ["198.51.100.127"]],
    ["203.0.113.4/31", ["203.0.113.4", "203.0.113.5"], ["203.0.113.3", "203.0.113.6"]],
    [
      "2001:db8::/32",
      ["2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::"],
    ],
    // Off a group's edge.
    [
      "3fff::/20",
      ["3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
      ["3fff:1000::", "3ffe:ffff::"],
    ],
    // A single address is /32 or /128: not its neighbours.
    ["192.0.2.7/32", ["192.0.2.7"], ["192.0.2.6", "192.0.2.8"]],
    ["2001:db8::7/128", ["2001:db8::7"], ["2001:db8::6", "2001:db8::8"]],
  ] as const)("%s", (entry, ins, outs) => {
    for (const a of ins) expect([a, inside(entry, a)]).toEqual([a, true]);
    for (const a of outs) expect([a, inside(entry, a)]).toEqual([a, false]);
  });

  it("/32 and /128 are the single address, in its written form", () => {
    expect(parseProxyEntry("192.0.2.7/32")).toMatchObject({ form: "192.0.2.7" });
    expect(parseProxyEntry("192.0.2.7")).toMatchObject({ form: "192.0.2.7" });
    expect(parseProxyEntry("2001:DB8:0::7/128")).toMatchObject({ form: "2001:db8::7" });
    expect(parseProxyEntry(" 2001:db8::7 ")).toMatchObject({ form: "2001:db8::7" });
  });

  it("the families do not mix: an IPv4 range takes no IPv6 address with the same leading bytes", () => {
    // c000:200:: begins with the bytes of 192.0.2.0.
    expect(inside("192.0.2.0/24", "c000:200::")).toBe(false);
    expect(inside("192.0.2.0/24", "c000:2ff::1")).toBe(false);
    expect(inside("c000::/8", "192.0.2.1")).toBe(false);
    expect(inside("2001:db8::/32", "32.1.13.184")).toBe(false);
    // Leading bits of 0 on both sides: the widths alone tell them apart.
    expect(inside("0.0.0.0/8", "::1")).toBe(false);
    expect(inside("0.0.0.0/8", "0.0.0.1")).toBe(true);
  });

  it("IPv4 written as IPv6: an address is the IPv4 one, a range inside ::ffff:0:0/96 the IPv4 range", () => {
    expect(inside("192.0.2.0/24", "::ffff:192.0.2.5")).toBe(true);
    expect(inside("192.0.2.0/24", "::ffff:c000:205")).toBe(true);
    expect(parseProxyEntry("::ffff:192.0.2.0/120")).toMatchObject({ form: "192.0.2.0/24" });
    expect(parseProxyEntry("::ffff:c000:200/120")).toMatchObject({ form: "192.0.2.0/24" });
    expect(parseProxyEntry("::ffff:192.0.2.7")).toMatchObject({ form: "192.0.2.7" });
    expect(inside("::ffff:192.0.2.0/120", "192.0.2.200")).toBe(true);
    expect(inside("::ffff:192.0.2.0/120", "192.0.3.0")).toBe(false);
  });

  it("an IPv6 range not touching ::ffff:0:0/96 takes no IPv4 address", () => {
    expect(parseProxyEntry("::/81")).toMatchObject({ form: "::/81" });
    expect(inside("::/81", "0.0.0.1")).toBe(false);
    expect(inside("::/81", "::ffff:0.0.0.1")).toBe(false);
    expect(inside("::/81", "::1")).toBe(true);
  });

  it.each([
    ["0.0.0.0/0", "everything"],
    ["::/0", "everything"],
    ["::ffff:0:0/96", "everything"],
    ["::ffff:0.0.0.0/96", "everything"],
    ["::/80", "everything"],
    ["::ff00:0:0/88", "everything"],
    ["::fffe:0:0/95", "everything"],
    ["192.0.2.1/24", "host_bits"],
    ["192.0.2.128/24", "host_bits"],
    ["192.0.2.1/31", "host_bits"],
    ["2001:db8::1/64", "host_bits"],
    ["2001:db8::/15", "host_bits"],
    ["::ffff:192.0.2.0/95", "host_bits"],
    // IPv4 written as IPv6 with its IPv4 part all zero: only the prefix under 96 refuses these.
    ["::ffff:0:0/95", "host_bits"],
    ["::ffff:0.0.0.0/64", "host_bits"],
    ["::ffff:0:0/80", "host_bits"],
    ["192.0.2.0/33", "prefix"],
    ["2001:db8::/129", "prefix"],
    ["192.0.2.0/-1", "prefix"],
    ["192.0.2.0/", "prefix"],
    ["192.0.2.0/08", "prefix"],
    ["192.0.2.0/24/24", "prefix"],
    ["192.0.2.0/ 24", "prefix"],
    ["192.0.2.0/1e1", "prefix"],
    ["192.0.2.0 /24", "not_an_address"],
    ["fe80::%en0/64", "not_an_address"],
    ["192.0.2.0:80/24", "not_an_address"],
    ["/24", "not_an_address"],
    ["", "not_an_address"],
  ] as const)("%j is refused: %s", (entry, problem) => {
    expect(parseProxyEntry(entry)).toBe(problem);
  });

  it("the smallest ranges not refused: /1 of each family, and a range just past ::ffff:0:0/96's cover", () => {
    expect(parseProxyEntry("128.0.0.0/1")).toMatchObject({ form: "128.0.0.0/1" });
    expect(inside("128.0.0.0/1", "255.255.255.255")).toBe(true);
    expect(inside("128.0.0.0/1", "127.255.255.255")).toBe(false);
    expect(parseProxyEntry("8000::/1")).toMatchObject({ form: "8000::/1" });
    expect(parseProxyEntry("::fffe:0:0/96")).toMatchObject({ form: "::fffe:0:0/96" });
  });
});

describe("the request's source, behind trusted proxy ranges", () => {
  // A CDN whose egress is a range, in front of a load balancer in a subnet of its own.
  const proxies = trustedProxies([
    "10.0.0.0/16",
    "198.51.100.0/24",
    "2001:db8:cd::/48",
    "192.0.2.10",
  ]);

  it("the connection inside a range: past every hop inside one, to the client", () => {
    expect(
      requestSource({
        connection: "10.0.3.4",
        forwardedFor: "203.0.113.9, 198.51.100.77",
        trusted: proxies,
      }),
    ).toBe("203.0.113.9");
    expect(
      requestSource({
        connection: "::ffff:10.0.255.255",
        forwardedFor: ["203.0.113.9", "2001:db8:cd:ffff::1, 192.0.2.10"],
        trusted: proxies,
      }),
    ).toBe("203.0.113.9");
  });

  it("the connection just outside every range: the header is not read", () => {
    expect(
      requestSource({ connection: "10.1.0.0", forwardedFor: "203.0.113.9", trusted: proxies }),
    ).toBe("10.1.0.0");
    expect(
      requestSource({ connection: "192.0.2.11", forwardedFor: "203.0.113.9", trusted: proxies }),
    ).toBe("192.0.2.11");
  });

  it("a hop just outside the egress range is the source: an egress the list has not caught up with", () => {
    expect(
      requestSource({
        connection: "10.0.0.1",
        forwardedFor: "203.0.113.9, 198.51.101.0",
        trusted: proxies,
      }),
    ).toBe("198.51.101.0");
  });

  it("every entry inside a range: the leftmost, even one the client wrote", () => {
    expect(
      requestSource({
        connection: "10.0.0.1",
        forwardedFor: "198.51.100.1, 2001:db8:cd::9, 198.51.100.200",
        trusted: proxies,
      }),
    ).toBe("198.51.100.1");
  });

  it("an entry that is no address stops the walk at the last trusted hop, a range's included", () => {
    expect(
      requestSource({
        connection: "10.0.0.1",
        forwardedFor: "203.0.113.9, 198.51.100.0/24, 198.51.100.3",
        trusted: proxies,
      }),
    ).toBe("198.51.100.3");
  });
});
