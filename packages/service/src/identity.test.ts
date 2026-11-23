// The identity provider's shared rules (02-architecture §12): where a login may return to, escaping,
// a page's language, and how a cookie to set is written.

import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  pageLanguage,
  RETURN_TO_MAX,
  type SetCookie,
  safeReturnTo,
  setCookieHeader,
  sourceKey,
  wideSourceKey,
} from "./identity.ts";

describe("where a login may return to", () => {
  it("a path under /oauth/", () => {
    expect(safeReturnTo("/oauth/authorize?client_id=x")).toBe("/oauth/authorize?client_id=x");
  });
  it("not a path of two leading slashes, nor slash and backslash", () => {
    expect(safeReturnTo("//evil.example/oauth/")).toBeUndefined();
    expect(safeReturnTo("/\\evil.example")).toBeUndefined();
  });
  it("not a URL with a scheme", () => {
    expect(safeReturnTo("https://evil.example/oauth/")).toBeUndefined();
    expect(safeReturnTo("javascript:alert(1)")).toBeUndefined();
  });
  it("not with a backslash or a control character anywhere", () => {
    expect(safeReturnTo("/oauth/a\\b")).toBeUndefined();
    expect(safeReturnTo("/oauth/a\nb")).toBeUndefined();
    expect(safeReturnTo("/oauth/a\u007fb")).toBeUndefined();
  });
  it("not with a character outside printable ASCII, in its path or its query", () => {
    for (const v of [
      "/oauth/中",
      "/oauth/a b",
      "/oauth/caf\u00e9",
      "/oauth/x?a=中",
      "/oauth/x#\u00a0",
    ]) {
      expect([v, safeReturnTo(v)]).toEqual([v, undefined]);
    }
  });
  it("not climbing out of /oauth/ by a dot segment, plain or encoded", () => {
    for (const v of [
      "/oauth/../account/logout",
      "/oauth/%2e%2e/account/logout",
      "/oauth/%2E%2E/account/logout",
      "/oauth/a/../../v1/export",
      "/oauth/./x",
      "/oauth/a/..",
      "/oauth/.%2e/x",
      "/oauth/a%2f..%2f..%2fv1",
      "/oauth/a%5c..",
      // Decoded once more by a route, these would be the ones above.
      "/oauth/%252e%252e/account/logout",
      "/oauth/%252E%252E/account/logout",
      "/oauth/a%252f..%252f..%252fv1",
    ]) {
      expect([v, safeReturnTo(v)]).toEqual([v, undefined]);
    }
  });
  it("in its path only: a query may hold dots and encoded slashes", () => {
    const v = "/oauth/authorize?redirect_uri=https%3A%2F%2Fc.example%2F..%2Fcb&state=a.b%25";
    expect(safeReturnTo(v)).toBe(v);
  });
  it("not under /OAUTH/ or any other case", () => {
    expect(safeReturnTo("/OAUTH/authorize")).toBeUndefined();
    expect(safeReturnTo("/OAuth/authorize")).toBeUndefined();
  });
  it("not outside /oauth/", () => {
    expect(safeReturnTo("/v1/catalog")).toBeUndefined();
    expect(safeReturnTo("/oauthx/")).toBeUndefined();
  });
  it("not longer than the limit, and never cut short", () => {
    const at = `/oauth/${"a".repeat(RETURN_TO_MAX - 7)}`;
    expect(at.length).toBe(RETURN_TO_MAX);
    expect(safeReturnTo(at)).toBe(at);
    expect(safeReturnTo(`${at}a`)).toBeUndefined();
  });
});

describe("text written into a page", () => {
  it("is escaped in text and in quoted attributes", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });
  it("is English unless the first language asked for is Chinese", () => {
    expect(pageLanguage(undefined)).toBe("en");
    expect(pageLanguage("en-US,zh;q=0.9")).toBe("en");
    expect(pageLanguage("zh-CN,en;q=0.8")).toBe("zh");
    expect(pageLanguage("ZH-tw")).toBe("zh");
  });
});

describe("a cookie to set", () => {
  const c: SetCookie = { name: "a", value: "v1", maxAgeSeconds: 600, path: "/", secure: true };

  it("is HttpOnly, Lax unless it says Strict, and Secure when it is secure", () => {
    expect(setCookieHeader(c)).toBe("a=v1; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure");
    expect(setCookieHeader({ ...c, sameSite: "Strict", secure: false, path: "/oauth/" })).toBe(
      "a=v1; Path=/oauth/; Max-Age=600; HttpOnly; SameSite=Strict",
    );
  });

  it("is cleared with an age of 0", () => {
    expect(setCookieHeader({ ...c, value: "", maxAgeSeconds: 0 })).toBe(
      "a=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    );
  });

  it("named __Host- is secure with path /, or is refused", () => {
    expect(setCookieHeader({ ...c, name: "__Host-a" })).toMatch(/^__Host-a=v1; Path=\/;/);
    expect(() => setCookieHeader({ ...c, name: "__Host-a", secure: false })).toThrow();
    expect(() => setCookieHeader({ ...c, name: "__Host-a", path: "/oauth/" })).toThrow();
  });

  it("refuses what would write a second attribute or another header", () => {
    expect(() => setCookieHeader({ ...c, value: "v; Domain=evil.example" })).toThrow();
    expect(() => setCookieHeader({ ...c, value: "v\r\nSet-Cookie: b=1" })).toThrow();
    expect(() => setCookieHeader({ ...c, name: "a=b" })).toThrow();
    expect(() => setCookieHeader({ ...c, path: "/; Domain=evil.example" })).toThrow();
    expect(() => setCookieHeader({ ...c, path: "/\r\nSet-Cookie: b=1" })).toThrow();
    expect(() => setCookieHeader({ ...c, path: "/a\nb" })).toThrow();
    expect(() => setCookieHeader({ ...c, path: "relative" })).toThrow();
    expect(() => setCookieHeader({ ...c, maxAgeSeconds: -1 })).toThrow();
    expect(() => setCookieHeader({ ...c, maxAgeSeconds: 1.5 })).toThrow();
  });
});

describe("the source a request is counted under", () => {
  it("is an IPv4 address as it is, an IPv4-mapped one as IPv4, an IPv6 one by its /64", () => {
    expect(sourceKey("192.0.2.7")).toBe("192.0.2.7");
    expect(sourceKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(sourceKey("2001:db8:1:2::5")).toBe("2001:db8:1:2::/64");
    expect(sourceKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(sourceKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(sourceKey("::1")).toBe("0:0:0:0::/64");
    expect(sourceKey("2001:db8:1:3::1")).not.toBe(sourceKey("2001:db8:1:2::1"));
    expect(sourceKey("not an address")).toBe("not an address");
  });
});

describe("the wider source an IPv6 request is also counted under", () => {
  it("is its /48; none for IPv4 or an IPv4-mapped address", () => {
    expect(wideSourceKey("2001:db8:1:2::5")).toBe("2001:db8:1::/48");
    expect(wideSourceKey("2001:db8:1:ffff::1")).toBe("2001:db8:1::/48");
    expect(wideSourceKey("2001:db8:2::1")).toBe("2001:db8:2::/48");
    expect(wideSourceKey("192.0.2.7")).toBeUndefined();
    expect(wideSourceKey("::ffff:192.0.2.7")).toBeUndefined();
  });
});
