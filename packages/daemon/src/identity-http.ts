// A Node HTTP request as an identity provider takes it, and its answer written back
// (docs/zh-CN/spec/05-surfaces.md §15 «本地账户的登录页»; 02-architecture §12 «身份提供者»). A name
// given more than once, in the query, the headers, the cookies or a form, counts by its first value.
// A cookie is set only through the service's `setCookieHeader`.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Fields,
  type IdentityRequest,
  type IdentityResponse,
  setCookieHeader,
} from "@fluxvita/saveslot-service";

/** The largest form body read: a login form is a few short fields. */
export const MAX_FORM_BYTES = 16 * 1024;

const firstOf = (pairs: Iterable<readonly [string, string]>): Fields => {
  const m = new Map<string, string>();
  for (const [k, v] of pairs) if (!m.has(k)) m.set(k, v);
  return m;
};

/** Each header by its lower-case name, the first of a name given twice. */
function headerPairs(req: IncomingMessage): [string, string][] {
  const out: [string, string][] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    out.push([(raw[i] as string).toLowerCase(), raw[i + 1] as string]);
  }
  return out;
}

/** The cookies of every `Cookie` header, in order; a piece without `=` is not a cookie. */
function cookiePairs(headers: readonly [string, string][]): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of headers) {
    if (name !== "cookie") continue;
    for (const piece of value.split(";")) {
      const i = piece.indexOf("=");
      if (i <= 0) continue;
      out.push([piece.slice(0, i).trim(), piece.slice(i + 1).trim()]);
    }
  }
  return out;
}

/**
 * The form of a request whose body is `application/x-www-form-urlencoded`: undefined for another
 * type; `too_large` past `MAX_FORM_BYTES`, the rest left unread.
 */
export async function readForm(req: IncomingMessage): Promise<Fields | "too_large" | undefined> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_FORM_BYTES) return "too_large";
    chunks.push(c);
  }
  return firstOf(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

/** The request as an identity provider takes it; `remote` is the request's source. */
export function identityRequest(
  req: IncomingMessage,
  remote: string,
  form?: Fields,
): IdentityRequest {
  const url = new URL(req.url ?? "/", "http://local");
  const headers = headerPairs(req);
  return {
    method: req.method ?? "GET",
    path: url.pathname,
    query: firstOf(url.searchParams),
    headers: firstOf(headers),
    cookies: firstOf(cookiePairs(headers)),
    remote,
    ...(form !== undefined ? { form } : {}),
  };
}

/** Writes a provider's answer: a page, or a redirect (303: a form's POST is answered by a GET). */
export function sendIdentityResponse(res: ServerResponse, r: IdentityResponse): void {
  const cookies = (r.cookies ?? []).map(setCookieHeader);
  const common = {
    ...Object.fromEntries(r.headers ?? []),
    "cache-control": "no-store",
    ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
  };
  if (r.kind === "redirect") {
    res.writeHead(303, { ...common, location: r.location, "content-length": 0 });
    res.end();
    return;
  }
  const body = Buffer.from(r.html, "utf8");
  res.writeHead(r.status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    ...common,
  });
  res.end(body);
}
