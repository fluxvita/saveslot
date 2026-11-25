// Properties of the trusted proxy ranges (02-architecture §5 «请求来源地址»), judged by an oracle of
// its own: addresses as strings of 0s and 1s, a range holding an address when the first `prefix`
// characters are the same. For any address and prefix written as an entry:
//   - bits set past the prefix refuse it; a range of every address, or one covering ::ffff:0:0/96
//     from wider than /96, refuses it; otherwise it is taken;
//   - a range taken holds an address exactly when the oracle says so, for a random address and,
//     made for every range rather than hoped for, its first and last address and the ones next to
//     them; never an address of the other family;
//   - an IPv4 range written as IPv6 (`::ffff:a.b.c.d/96+n`) is the IPv4 range.
// IPv6 addresses are drawn from everywhere, and on purpose from inside ::ffff:0:0/96 (with IPv4
// parts ending in zeros, down to all of them), around it, and from the low addresses: an entry
// written there is IPv4 written as IPv6, judged by its bits as any other, and taken as the IPv4
// range of its last 32 bits when its prefix is 96 or more.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseProxyEntry, trustedProxies } from "./request-source.ts";

const RUNS = 500;

const bitsOf = (n: bigint, width: number): string => n.toString(2).padStart(width, "0");

const v4Text = (n: bigint): string =>
  [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join(".");

/** Every group written out, in upper or lower case: what `normalizeAddress` makes of it is its job. */
const v6Text = (n: bigint, upper: boolean): string => {
  const t = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n]
    .map((s) => ((n >> s) & 0xffffn).toString(16))
    .join(":");
  return upper ? t.toUpperCase() : t;
};

const MAPPED_BITS = bitsOf(0xffffn << 32n, 128);

/** The oracle's answer for an entry: a problem, or the range as bits. */
function judged(
  bits: string,
  prefix: number,
): "host_bits" | "everything" | { readonly net: string; readonly prefix: number } {
  if (bits.slice(prefix).includes("1")) return "host_bits";
  if (prefix === 0) return "everything";
  // IPv4 written as IPv6 with a prefix of 96 or more: the IPv4 range of its last 32 bits.
  if (bits.length === 128 && prefix >= 96 && bits.slice(0, 96) === MAPPED_BITS.slice(0, 96)) {
    return prefix === 96 ? "everything" : { net: bits.slice(0, prefix), prefix };
  }
  if (
    bits.length === 128 &&
    prefix < 96 &&
    MAPPED_BITS.slice(0, prefix) === bits.slice(0, prefix)
  ) {
    return "everything";
  }
  return { net: bits.slice(0, prefix), prefix };
}

const holds = (net: string, address: string): boolean => address.startsWith(net);

/** The addresses a range is checked at: a random one, both ends, and the ones next to them. */
function probes(net: bigint, prefix: number, width: number, random: bigint): bigint[] {
  const size = 1n << BigInt(width - prefix);
  const top = (1n << BigInt(width)) - 1n;
  return [random, net, net + size - 1n, net - 1n, net + size].filter((a) => a >= 0n && a <= top);
}

describe("trusted proxy ranges against an oracle of bits", () => {
  it("IPv4: what is refused, and what a range taken holds", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: (1n << 32n) - 1n }),
        fc.integer({ min: 0, max: 32 }),
        fc.bigInt({ min: 0n, max: (1n << 32n) - 1n }),
        fc.boolean(),
        (address, prefix, random, masked) => {
          // Half the entries masked to the range's first address, so that most are taken.
          const shift = BigInt(32 - prefix);
          const a = masked ? (address >> shift) << shift : address;
          const want = judged(bitsOf(a, 32), prefix);
          const got = parseProxyEntry(`${v4Text(a)}/${prefix}`);
          if (typeof want === "string") {
            expect(got).toBe(want);
            return;
          }
          expect(typeof got).toBe("object");
          const t = trustedProxies([`${v4Text(a)}/${prefix}`]);
          for (const p of probes(a, prefix, 32, random)) {
            expect([v4Text(p), t.has(v4Text(p))]).toEqual([
              v4Text(p),
              holds(want.net, bitsOf(p, 32)),
            ]);
            // The other family never: these bits as an IPv6 address's leading ones.
            expect(t.has(v6Text((p << 96n) | 1n, false))).toBe(false);
          }
          // Written as IPv6, it is the same range.
          const mapped = parseProxyEntry(`::ffff:${v4Text(a)}/${prefix + 96}`);
          expect(mapped).toEqual(got);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("IPv6: what is refused, and what a range taken holds", () => {
    const MAPPED = 0xffffn << 32n;
    const v6 = fc.oneof(
      fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }),
      // Inside ::ffff:0:0/96, the IPv4 part ending in k zero bits (all of it zero at k = 32).
      fc
        .tuple(fc.bigInt({ min: 0n, max: (1n << 32n) - 1n }), fc.integer({ min: 0, max: 32 }))
        .map(([v4, k]) => MAPPED | ((v4 >> BigInt(k)) << BigInt(k))),
      // Around it, and the low addresses.
      fc.bigInt({ min: MAPPED - (1n << 40n), max: MAPPED + (1n << 40n) }),
      fc.bigInt({ min: 0n, max: 1n << 48n }),
    );
    fc.assert(
      fc.property(
        v6,
        fc.integer({ min: 0, max: 128 }),
        v6,
        fc.boolean(),
        fc.boolean(),
        (address, prefix, random, masked, upper) => {
          const shift = BigInt(128 - prefix);
          const a = masked ? (address >> shift) << shift : address;
          const want = judged(bitsOf(a, 128), prefix);
          const entry = `${v6Text(a, upper)}/${prefix}`;
          const got = parseProxyEntry(entry);
          if (typeof want === "string") {
            expect(got).toBe(want);
            return;
          }
          expect(typeof got).toBe("object");
          const t = trustedProxies([entry]);
          for (const p of probes(a, prefix, 128, random)) {
            // A probe inside ::ffff:0:0/96 is an IPv4 address; its bits judge it all the same.
            expect([v6Text(p, false), t.has(v6Text(p, false))]).toEqual([
              v6Text(p, false),
              holds(want.net, bitsOf(p, 128)),
            ]);
          }
          // The other family never: an IPv6 range takes no IPv4 address, and a range written as
          // IPv4 in IPv6 no IPv6 one (a first bit of 1 is outside ::ffff:0:0/96).
          if (bitsOf(a, 128).slice(0, 96) === MAPPED_BITS.slice(0, 96)) {
            expect(t.has(v6Text(random | (1n << 127n), false))).toBe(false);
          } else {
            expect(t.has(v4Text(random >> 96n))).toBe(false);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
