// Requests from a page of another site (docs/zh-CN/spec/05-surfaces.md §14): a request to `/mcp`
// or `/v1` of the server mode that carries an `Origin`, and not the external address's, is refused
// with 403 before it reaches the MCP adapter or an operation (the MCP transport's guard against
// DNS rebinding). The hosts call from their servers and send no `Origin`. The answer is plain text:
// no contract error fits a request that never reaches the contract.

import type { IncomingMessage } from "node:http";

export interface OriginRefusal {
  readonly status: 403;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const REFUSAL: OriginRefusal = {
  status: 403,
  headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  body: "Requests from this origin are not taken.\n",
};

/**
 * Undefined when the request may go on; the 403 to send when it carries an `Origin` other than
 * `externalOrigin` (an origin as `URL.origin` writes it: scheme, host and a port other than the
 * default). An `Origin` given twice, or `null`, is not the external one.
 */
export function originGuard(
  req: IncomingMessage,
  externalOrigin: string,
): OriginRefusal | undefined {
  const raw = req.rawHeaders;
  const given: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if ((raw[i] as string).toLowerCase() === "origin") given.push(raw[i + 1] as string);
  }
  if (given.length === 0) return undefined;
  return given.length === 1 && given[0] === externalOrigin ? undefined : REFUSAL;
}
