// Where a request comes from (docs/zh-CN/spec/02-architecture.md §5 «请求来源地址»): the address
// the identity provider counts failed logins by. The server mode is reached through a reverse
// proxy, whose address every request would otherwise share; so `X-Forwarded-For` is read, but only
// when the connection itself comes from a trusted proxy (`SAVESLOT_TRUSTED_PROXIES`, read with the
// rest of the server's configuration): what a client writes in that header on its own counts for
// nothing. The `Forwarded` header is not read. A trusted proxy is an address inside one of the
// list's entries, each a single address or a CIDR range.

import { isIP } from "node:net";

/**
 * An address in one written form, or undefined when it is not a single bare address: IPv4 as it is,
 * IPv4 written as IPv6 (`::ffff:a.b.c.d`) as IPv4, IPv6 in lower case and compressed. No port, no
 * zone (a link-local address with one is not taken), no range.
 */
export function normalizeAddress(text: string): string | undefined {
  const s = text.trim();
  if (isIP(s) === 4) return s;
  if (isIP(s) !== 6 || s.includes("%")) return undefined;
  const v6 = new URL(`http://[${s}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (mapped !== null) {
    const hi = Number.parseInt(mapped[1] as string, 16);
    const lo = Number.parseInt(mapped[2] as string, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return v6;
}

/** The bits of an address as `normalizeAddress` writes it, with its family's width. */
function addressBits(normal: string): { readonly width: 32 | 128; readonly bits: bigint } {
  if (isIP(normal) === 4) {
    let bits = 0n;
    for (const octet of normal.split(".")) bits = (bits << 8n) | BigInt(Number(octet));
    return { width: 32, bits };
  }
  // Compressed, in hex groups only: the URL parser writes no embedded IPv4 part.
  const [head, tail] = normal.includes("::")
    ? (normal.split("::") as [string, string])
    : [normal, undefined];
  const h = head === "" ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  let bits = 0n;
  for (const g of groups) bits = (bits << 16n) | BigInt(Number.parseInt(g, 16));
  return { width: 128, bits };
}

/** `::ffff:0:0/96`: the IPv6 form of every IPv4 address. */
const MAPPED = 0xffffn << 32n;

/** A trusted proxy entry: the addresses whose first `prefix` bits are `network`'s. */
export interface ProxyRange {
  readonly width: 32 | 128;
  readonly network: bigint;
  readonly prefix: number;
  /** In one written form: the address alone for a single one (`/32`, `/128`), else `address/prefix`. */
  readonly form: string;
}

/** Why an entry of the trusted proxies is refused. */
export type ProxyEntryProblem =
  /** Not an address, nor an address, a `/` and a prefix length (a port, a zone, a name…). */
  | "not_an_address"
  /** The prefix length is not a plain decimal within the family's width. */
  | "prefix"
  /** The address has bits set past the prefix: the network and a host in it mixed up. */
  | "host_bits"
  /** It holds every address of a family, so any client could write its own source. */
  | "everything";

const same = (a: bigint, b: bigint, width: number, prefix: number): boolean => {
  const shift = BigInt(width - prefix);
  return a >> shift === b >> shift;
};

/**
 * One entry of `SAVESLOT_TRUSTED_PROXIES` (02-architecture §5): a single address, or a CIDR range
 * `address/prefix` with no bits set past the prefix. An IPv6 range inside `::ffff:0:0/96` is the
 * IPv4 range it writes, since sources are compared as IPv4; one wider than that block and covering
 * it, like a range of every address, is refused.
 */
export function parseProxyEntry(text: string): ProxyRange | ProxyEntryProblem {
  const entry = text.trim();
  const slash = entry.indexOf("/");
  const written = slash === -1 ? entry : entry.slice(0, slash);
  // Spaces around the entry are dropped; none inside it, around the `/` included.
  if (written !== written.trim()) return "not_an_address";
  const normal = normalizeAddress(written);
  if (normal === undefined) return "not_an_address";
  const writtenWidth = isIP(written) === 4 ? 32 : 128;
  let prefix = writtenWidth;
  if (slash !== -1) {
    const p = entry.slice(slash + 1);
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > writtenWidth) return "prefix";
    prefix = Number(p);
  }
  const { width, bits } = addressBits(normal);
  if (width !== writtenWidth) {
    // IPv4 written as IPv6: its first 96 bits are the block's, so a prefix under 96 leaves some of
    // them as host bits.
    if (prefix < 96) return "host_bits";
    prefix -= 96;
  }
  if ((bits & ((1n << BigInt(width - prefix)) - 1n)) !== 0n) return "host_bits";
  if (prefix === 0) return "everything";
  if (width === 128 && prefix < 96 && same(bits, MAPPED, 128, prefix)) return "everything";
  return { width, network: bits, prefix, form: prefix === width ? normal : `${normal}/${prefix}` };
}

/**
 * Which addresses are trusted proxies'. Made only by `trustedProxies`, from entries checked by
 * `parseProxyEntry`: a class with a private field, so that nothing else with a `has` (a set of
 * strings, compared as written) stands in for it and quietly loses the ranges.
 */
export class TrustedProxies {
  readonly #ranges: readonly ProxyRange[];

  private constructor(ranges: readonly ProxyRange[]) {
    this.#ranges = ranges;
  }

  /** The trusted proxies of a list of entries, each as `parseProxyEntry` takes it. */
  static of(entries: readonly string[]): TrustedProxies {
    return new TrustedProxies(
      entries.map((e) => {
        const r = parseProxyEntry(e);
        if (typeof r === "string") throw new Error(`not a trusted proxy entry (${r})`);
        return r;
      }),
    );
  }

  /** Whether `address` is inside one of the entries; false for what is not a single address. */
  has(address: string): boolean {
    const normal = normalizeAddress(address);
    if (normal === undefined) return false;
    const { width, bits } = addressBits(normal);
    return this.#ranges.some((r) => r.width === width && same(bits, r.network, width, r.prefix));
  }
}

/** The trusted proxies of a list of entries, each as `parseProxyEntry` takes it. */
export const trustedProxies = (entries: readonly string[]): TrustedProxies =>
  TrustedProxies.of(entries);

/**
 * The request's source: the connection's address, unless the connection comes from a trusted proxy.
 * Then `X-Forwarded-For` is read from the right, where each trusted proxy appended the address it
 * was reached from, past the trusted ones: the first entry that is not a trusted address ends the
 * walk; an address, it is the source; anything else, the source is the last trusted hop (the
 * connection, when that is the rightmost entry). Nothing to its left is read: that part is the
 * client's to write. When every entry is trusted, the leftmost. Undefined when the connection has
 * no single usable address (a unix socket, a link-local address with a zone).
 */
export function requestSource(o: {
  /** The connection's address (`socket.remoteAddress`). */
  readonly connection: string | undefined;
  /** Every `X-Forwarded-For` header of the request, as received. */
  readonly forwardedFor: string | readonly string[] | undefined;
  /** The trusted proxies (`trustedProxies`). */
  readonly trusted: TrustedProxies;
}): string | undefined {
  const connection = o.connection === undefined ? undefined : normalizeAddress(o.connection);
  if (connection === undefined || !o.trusted.has(connection)) return connection;
  const raw = o.forwardedFor === undefined ? [] : [o.forwardedFor].flat();
  if (raw.length === 0) return connection;
  const entries = raw.join(",").split(",");
  let last = connection;
  for (let i = entries.length - 1; i >= 0; i--) {
    const a = normalizeAddress(entries[i] as string);
    if (a === undefined) return last;
    if (!o.trusted.has(a)) return a;
    last = a;
  }
  return last;
}
