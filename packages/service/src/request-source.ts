// Where a request comes from (docs/zh-CN/spec/02-architecture.md §5 «身份»): the address the
// identity provider counts failed logins by. The server mode is reached through a reverse proxy,
// whose address every request would otherwise share; so `X-Forwarded-For` is read, but only when
// the connection itself comes from a trusted proxy (`SAVESLOT_TRUSTED_PROXIES`, read with the rest
// of the server's configuration): what a client writes in that header on its own counts for
// nothing. The `Forwarded` header is not read.

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
  /** The trusted proxies' addresses, each as `normalizeAddress` writes it. */
  readonly trusted: ReadonlySet<string>;
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
