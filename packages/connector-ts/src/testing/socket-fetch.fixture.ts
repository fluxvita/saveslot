// A `fetch` over a unix socket, for `setFetch`: how a connector reaches the local service, which
// listens on a socket only. The README shows the same function; the tests use this copy, so the
// README's version is the one that is run.

import { request } from "node:http";

/** A `fetch` that sends every request to the service listening on `socketPath`. */
export function socketFetch(socketPath: string): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // A Buffer, not a string: Node writes the head together with a first string chunk in that
    // chunk's encoding, which would turn header values already UTF-8 into UTF-8 twice.
    const body =
      init.body === undefined || init.body === null ? undefined : Buffer.from(String(init.body));
    return await new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          socketPath,
          method: init.method ?? "GET",
          path: url.pathname + url.search,
          headers: Object.fromEntries(new Headers(init.headers)),
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
            }
            const status = res.statusCode ?? 0;
            const empty = status === 204 || status === 304;
            resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }) as typeof fetch;
}
