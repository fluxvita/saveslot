// A Node request as an identity provider takes it, and its answer written back (05-surfaces §15
// «本地账户的登录页»): a name given twice counts by its first value; a form is read only when it is
// one, and only so far; cookies are set through `setCookieHeader`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  identityRequest,
  MAX_FORM_BYTES,
  readForm,
  sendIdentityResponse,
} from "./identity-http.ts";

/** A request with these raw headers (name, value, name, value, …) and this body. */
function req(
  o: { method?: string; url?: string; raw?: string[]; body?: string | Buffer } = {},
): IncomingMessage {
  const r = Readable.from(o.body === undefined ? [] : [Buffer.from(o.body)]) as unknown as {
    -readonly [K in keyof IncomingMessage]: IncomingMessage[K];
  };
  r.method = o.method ?? "GET";
  r.url = o.url ?? "/";
  r.rawHeaders = o.raw ?? [];
  const headers: Record<string, string> = {};
  for (let i = 0; i + 1 < r.rawHeaders.length; i += 2) {
    const k = (r.rawHeaders[i] as string).toLowerCase();
    headers[k] ??= r.rawHeaders[i + 1] as string;
  }
  r.headers = headers;
  return r as IncomingMessage;
}

/** A response that records what was written. */
function res() {
  const seen = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const r = {
    writeHead: (status: number, headers: Record<string, unknown>) => {
      seen.status = status;
      seen.headers = headers;
    },
    end: (b?: Buffer) => {
      seen.body = b === undefined ? "" : b.toString("utf8");
    },
  } as unknown as ServerResponse;
  return { r, seen };
}

describe("identityRequest", () => {
  it("the path without its query; query, headers and cookies by their first value", () => {
    const x = identityRequest(
      req({
        url: "/account/login?return_to=%2Foauth%2F&return_to=%2Fevil",
        raw: [
          "Accept-Language",
          "zh-CN",
          "accept-language",
          "en",
          "Cookie",
          "a=1; b=2",
          "Cookie",
          "a=3",
        ],
      }),
      "203.0.113.5",
    );
    expect(x.path).toBe("/account/login");
    expect(x.query.get("return_to")).toBe("/oauth/");
    expect(x.headers.get("accept-language")).toBe("zh-CN");
    expect([x.cookies.get("a"), x.cookies.get("b")]).toEqual(["1", "2"]);
    expect(x.remote).toBe("203.0.113.5");
    expect(x).not.toHaveProperty("form");
  });

  it("a cookie piece with no name or no '=' is not a cookie", () => {
    const x = identityRequest(req({ raw: ["Cookie", "=v; loose; c=4"] }), "::1");
    expect([...x.cookies]).toEqual([["c", "4"]]);
  });
});

describe("readForm", () => {
  const FORM = ["Content-Type", "application/x-www-form-urlencoded; charset=utf-8"];

  it("a urlencoded body, by its fields' first values", async () => {
    const f = await readForm(
      req({ method: "POST", raw: FORM, body: "name=alex&name=other&p=a%26b" }),
    );
    expect(f === undefined || f === "too_large" ? f : [...f]).toEqual([
      ["name", "alex"],
      ["p", "a&b"],
    ]);
  });

  it("another type is not read", async () => {
    const r = req({ method: "POST", raw: ["Content-Type", "application/json"], body: "{}" });
    expect(await readForm(r)).toBeUndefined();
    // Its body is still there for whoever answers it.
    expect(r.read()?.toString()).toBe("{}");
  });

  it("past its limit: too_large", async () => {
    const body = `x=${"a".repeat(MAX_FORM_BYTES)}`;
    expect(await readForm(req({ method: "POST", raw: FORM, body }))).toBe("too_large");
  });
});

describe("sendIdentityResponse", () => {
  const cookie = {
    name: "saveslot_login",
    value: "v1",
    path: "/",
    maxAgeSeconds: 60,
    secure: false,
  };

  it("a page: its status, HTML, its own headers, no caching, cookies as setCookieHeader writes them", () => {
    const { r, seen } = res();
    sendIdentityResponse(r, {
      kind: "page",
      status: 401,
      html: "<p>no</p>",
      headers: [["content-security-policy", "frame-ancestors 'none'"]],
      cookies: [cookie],
    });
    expect(seen.status).toBe(401);
    expect(seen.body).toBe("<p>no</p>");
    expect(seen.headers).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "frame-ancestors 'none'",
      "cache-control": "no-store",
      "set-cookie": ["saveslot_login=v1; Path=/; Max-Age=60; HttpOnly; SameSite=Lax"],
    });
  });

  it("a redirect: 303 to its location, with its headers and cookies", () => {
    const { r, seen } = res();
    sendIdentityResponse(r, {
      kind: "redirect",
      location: "/oauth/authorize?x=1",
      headers: [["x-frame-options", "DENY"]],
      cookies: [{ ...cookie, maxAgeSeconds: 0 }],
    });
    expect(seen.status).toBe(303);
    expect(seen.headers).toMatchObject({
      location: "/oauth/authorize?x=1",
      "x-frame-options": "DENY",
      "set-cookie": ["saveslot_login=v1; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"],
    });
  });

  it("a cookie setCookieHeader refuses is not written: the response fails instead", () => {
    const { r } = res();
    expect(() =>
      sendIdentityResponse(r, {
        kind: "redirect",
        location: "/",
        cookies: [{ ...cookie, value: "a;b" }],
      }),
    ).toThrow("not a value a cookie can carry");
  });

  it("a provider cannot unset no-store with a header of its own", () => {
    const { r, seen } = res();
    sendIdentityResponse(r, {
      kind: "page",
      status: 200,
      html: "",
      headers: [["cache-control", "public, max-age=600"]],
    });
    expect(seen.headers["cache-control"]).toBe("no-store");
  });
});
