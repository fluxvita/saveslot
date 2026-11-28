// Fetching a client ID metadata document (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»): the
// authorization server makes an HTTPS request to a URL a stranger chose, so the request is held in:
// - the host is resolved once, every address it resolves to is checked, and the connection goes to
//   the address checked (the TLS name and `Host` stay the host's), so a second answer from DNS
//   cannot send it inside;
// - loopback, private, link-local, unique-local, unspecified, multicast and reserved addresses are
//   refused, and so is an IPv4 address in an IPv6 form (IPv4-mapped, -compatible, NAT64, 6to4),
//   whatever the IPv4 part is; one refused address among several refuses the host;
// - HTTPS only, no redirect followed, a time limit, at most the document limit and one byte read.
// No configuration opens a range (v1).

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import {
  CLIENT_DOCUMENT_MAX_BYTES,
  ClientError,
  type ClientFetcher,
  type FetchedDocument,
} from "@fluxvita/saveslot-service";

/** How long a fetch may take, from the start of the lookup to the last byte. */
export const CLIENT_FETCH_TIMEOUT_MS = 5000;

// Two lists, each checked only for addresses of its own family: Node's BlockList checks an IPv4
// address against IPv6 rules as its IPv4-mapped form, so a mapped range in one list with the IPv4
// rules would refuse every IPv4 address.
const refused4 = new BlockList();
const refused6 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  refused4.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-compatible, IPv4-mapped, IPv4-translated: an IPv4 address in an IPv6 form.
  ["::", 96],
  ["::ffff:0:0", 96],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  // Documentation (RFC 9637) and segment routing SIDs (RFC 9602).
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  refused6.addSubnet(net, prefix, "ipv6");
}

/** Whether a connection to this address is refused. Anything that is not an address is. */
export function addressRefused(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return refused4.check(address, "ipv4");
  if (family === 6) return refused6.check(address, "ipv6");
  return true;
}

/** Resolves a host to all its addresses (the system resolver). */
export type Resolve = (host: string) => Promise<readonly LookupAddress[]>;

const systemResolve: Resolve = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (e, addresses) =>
      e === null ? resolve(addresses) : reject(e),
    ),
  );

const fail = (
  code: "fetch_failed" | "address_refused" | "document_too_large",
  what: string,
  status?: number,
) => new ClientError(code, `client document: ${what}`, status);

/** The `User-Agent` a fetch sends when none is given: saveslot, by name, with no contact. */
export const CLIENT_FETCH_USER_AGENT = "saveslot";

/**
 * The client fetcher of the server mode. `userAgent` names saveslot to the client's host
 * (`saveslot/<version>` from the server; a host that treats a request without one as a bot more
 * readily can allow it by rule). The other options are for tests: a resolver that answers what the
 * test says, and the HTTPS request function, so that no test goes out to the network.
 */
export function clientFetcher(
  o: {
    readonly userAgent?: string;
    readonly resolve?: Resolve;
    readonly request?: typeof httpsRequest;
    readonly timeoutMs?: number;
  } = {},
): ClientFetcher {
  const userAgent = o.userAgent ?? CLIENT_FETCH_USER_AGENT;
  const resolve = o.resolve ?? systemResolve;
  const request = o.request ?? httpsRequest;
  const timeoutMs = o.timeoutMs ?? CLIENT_FETCH_TIMEOUT_MS;
  return async (url) => {
    if (url.protocol !== "https:") throw fail("fetch_failed", "not HTTPS");
    const deadline = AbortSignal.timeout(timeoutMs);
    // The URL's host as a name for DNS: an IPv6 literal without its brackets.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    let addresses: readonly LookupAddress[];
    if (isIP(host) !== 0) {
      addresses = [{ address: host, family: isIP(host) }];
    } else {
      try {
        addresses = await Promise.race([
          resolve(host),
          new Promise<never>((_, reject) =>
            deadline.addEventListener("abort", () => reject(deadline.reason), { once: true }),
          ),
        ]);
      } catch {
        throw fail("fetch_failed", "the host could not be resolved in time");
      }
    }
    if (addresses.length === 0) throw fail("fetch_failed", "the host has no address");
    if (addresses.some((a) => addressRefused(a.address))) {
      throw fail("address_refused", "the host resolves to an address that is not public");
    }
    const pinned = addresses[0] as LookupAddress;
    return new Promise<FetchedDocument>((resolveDoc, reject) => {
      const req = request(
        {
          host,
          servername: isIP(host) === 0 ? host : undefined,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { accept: "application/json", "user-agent": userAgent },
          // The connection goes to the address checked above, whatever DNS says now.
          lookup: (_name, options, cb) => {
            if ((options as { all?: boolean }).all === true) {
              (cb as unknown as (e: null, a: LookupAddress[]) => void)(null, [pinned]);
            } else {
              cb(null, pinned.address, pinned.family);
            }
          },
          signal: deadline,
          agent: false,
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(
              fail(
                "fetch_failed",
                `answered ${res.statusCode} (redirects are not followed)`,
                res.statusCode,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > CLIENT_DOCUMENT_MAX_BYTES) {
              req.destroy();
              reject(fail("document_too_large", "larger than the limit"));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const cacheControl = res.headers["cache-control"];
            resolveDoc({
              body: new Uint8Array(Buffer.concat(chunks)),
              ...(typeof cacheControl === "string" ? { cacheControl } : {}),
            });
          });
          res.on("error", () => reject(fail("fetch_failed", "the response broke off")));
        },
      );
      req.on("error", () => reject(fail("fetch_failed", "no answer in time")));
      req.end();
    });
  };
}
