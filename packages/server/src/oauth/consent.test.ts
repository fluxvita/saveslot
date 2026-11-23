// The authorization page over real HTTP on the loopback, on a real control database and tenant (on
// either backend): signed out, the whole request goes through the sign-in; signed in, the page
// shows the request, and its answer form is good once and only for its sign-in; every refusal
// before the client and redirect URI pass is a page, never a redirect; consent gives a code that
// the token endpoint turns into a working credential. The identity provider is the test's own,
// signing in by a cookie. Fictional IDs, names and clients.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IdentityProvider, type IdentityRequest, tokenHash } from "@fluxvita/saveslot-service";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OAuthTestBed, oauthTestBed } from "../../../service/src/oauth.fixture.ts";
import { testBackend } from "../../../test-backend/src/index.fixture.ts";

import { handleOAuth } from "./routes.ts";

const T = 120_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-consent-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EXT = "https://saveslot.example";
const TENANT = `tn_${"8".repeat(26)}` as const;
const USER = `u_${"1".repeat(26)}` as const;
const DISABLED = `u_${"2".repeat(26)}` as const;
const NO_TENANT = `u_${"3".repeat(26)}` as const;
const NOW = "2026-11-21T08:00:00.000Z";
const ID = "https://client.example/oauth/client.json";
const REDIRECT = "https://client.example/callback";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const left = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();
/** Sign-ins of the stand-in provider, by the value of its `sid` cookie. */
const SIGN_INS = new Map([
  ["s-user", { user: USER, session: "session-1", name: "Alex <Example>", expiresAt: left(3600) }],
  ["s-user-2", { user: USER, session: "session-2", name: "Alex <Example>", expiresAt: left(3600) }],
  ["s-disabled", { user: DISABLED, session: "session-3", name: "Old", expiresAt: left(3600) }],
  ["s-no-tenant", { user: NO_TENANT, session: "session-4", name: "New", expiresAt: left(3600) }],
  // The login of `s-user`, read again when it has less time left than a code lasts.
  [
    "s-user-ending",
    { user: USER, session: "session-1", name: "Alex <Example>", expiresAt: left(59) },
  ],
  // A login with exactly a code's lifetime left.
  ["s-user-60", { user: USER, session: "session-5", name: "Alex <Example>", expiresAt: left(60) }],
]);
let loginsBegun: string[] = [];
const identity: IdentityProvider = {
  currentUser: async (req: IdentityRequest) => SIGN_INS.get(req.cookies.get("sid") ?? ""),
  beginLogin: async (_req, returnTo) => {
    loginsBegun.push(returnTo);
    return {
      kind: "redirect",
      location: `/account/login?return_to=${encodeURIComponent(returnTo)}`,
    };
  },
  userState: async (user) => (user === DISABLED ? "disabled" : "active"),
  paths: new Set<string>(),
  handle: async () => undefined,
  // Sessions are the token endpoint's (`bed.deps.identity`), never the page's.
  issueUserSession: async () => {
    throw new Error("the page issues no session");
  },
};

let bed: OAuthTestBed;
let server: Server;
let base: string;
let clientName = "Example <Agent>";
let names = 0;
/** A connection name not used before in this file's tenant. */
const freshName = (what: string) => `${what} ${names++}`;

beforeAll(async () => {
  bed = await oauthTestBed({
    backend: testBackend(),
    dir: root,
    tenant: TENANT,
    user: USER,
    now: NOW,
    external: EXT,
    fetchClient: async () => ({
      body: new TextEncoder().encode(
        JSON.stringify({ client_id: ID, client_name: clientName, redirect_uris: [REDIRECT] }),
      ),
    }),
  });
  // The CLI's code is redeemed from the login it was consented under.
  bed.logins.set("session-1", USER);
  const deps = bed.deps;
  server = createServer((req, res) => {
    handleOAuth(req, res, {
      deps,
      identity,
      remote: () => "127.0.0.1",
      now: () => NOW,
      log: () => {},
      warn: () => {},
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, T);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await bed?.close();
}, T);

beforeEach(async () => {
  loginsBegun = [];
  clientName = "Example <Agent>";
  await bed.control.write((tx) => tx.exec("DELETE FROM oauth_clients"));
});

const query = (o: Record<string, string | undefined> = {}) => {
  const q = new URLSearchParams();
  const all: Record<string, string | undefined> = {
    client_id: ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "st-1",
    ...o,
  };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) q.append(k, v);
  return q.toString();
};

const get = (q: string, sid?: string, lang?: string) =>
  fetch(`${base}/oauth/authorize?${q}`, {
    redirect: "manual",
    headers: {
      ...(sid === undefined ? {} : { cookie: `__proto__=x; sid=${sid}` }),
      ...(lang === undefined ? {} : { "accept-language": lang }),
    },
  });

const post = (q: string, sid: string | undefined, body: string) =>
  fetch(`${base}/oauth/authorize?${q}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(sid === undefined ? {} : { cookie: `sid=${sid}` }),
    },
    body,
  });

/** The page's form token and prefilled name. */
async function shown(r: Response) {
  const html = await r.text();
  return {
    html,
    token: /name="form_token" value="([^"]+)"/.exec(html)?.[1] as string,
    name: /name="name" maxlength="100" required value="([^"]*)"/.exec(html)?.[1],
  };
}

function expectPageHeaders(r: Response) {
  expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("referrer-policy")).toBe("no-referrer");
}

const entities = (s: string) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

const allow = (token: string, more = "") =>
  `form_token=${encodeURIComponent(token)}&decision=allow&scope=saveslot.read&scope=saveslot.write&name=${encodeURIComponent(freshName("Laptop"))}${more}`;

describe("signed out", () => {
  it(
    "the sign-in starts with the whole request as the way back",
    async () => {
      const q = query({ scope: "saveslot.read" });
      const r = await get(q);
      expect(r.status).toBe(302);
      expect(loginsBegun).toEqual([`/oauth/authorize?${q}`]);
      expect(r.headers.get("location")).toBe(
        `/account/login?return_to=${encodeURIComponent(`/oauth/authorize?${q}`)}`,
      );
    },
    T,
  );

  it(
    "a request too long to go through the sign-in: a page",
    async () => {
      const r = await get(query({ state: "x".repeat(5000) }));
      expect(r.status).toBe(400);
      expect(loginsBegun).toEqual([]);
    },
    T,
  );
});

describe("refused before the client and its redirect URI pass: a page, never a redirect", () => {
  it.each([
    ["an unusable client", { client_id: "http://client.example/c.json" }],
    ["a redirect URI the client did not list", { redirect_uri: "https://evil.example/cb" }],
  ])(
    "%s",
    async (_, change) => {
      const r = await get(query(change), "s-user");
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
      expectPageHeaders(r);
    },
    T,
  );

  it(
    "after they pass, an error goes back to the client with state and issuer",
    async () => {
      const r = await get(query({ response_type: "token" }), "s-user");
      expect(r.status).toBe(302);
      const to = new URL(r.headers.get("location") as string);
      expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
      expect(Object.fromEntries(to.searchParams)).toEqual({
        error: "unsupported_response_type",
        state: "st-1",
        iss: EXT,
      });
    },
    T,
  );
});

describe("signed in", () => {
  it(
    "the page: the client's name escaped, its host, who is signed in, a free name, the scopes",
    async () => {
      const r = await get(query(), "s-user");
      expect(r.status).toBe(200);
      expectPageHeaders(r);
      const { html, token, name } = await shown(r);
      expect(html).not.toContain("<Agent>");
      expect(html).toContain("Example &lt;Agent&gt;");
      expect(html).toContain("client.example");
      expect(html).toContain("Alex &lt;Example&gt;");
      expect(entities(name as string)).toBe("Example <Agent>");
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(html).toContain('name="scope" value="saveslot.write" checked');
      expect(html).not.toContain("saveslot.delete");
    },
    T,
  );

  it(
    "in Chinese when the browser's first language is Chinese, in English otherwise",
    async () => {
      expect((await shown(await get(query(), "s-user", "zh-CN,en;q=0.8"))).html).toContain(
        '<html lang="zh-CN">',
      );
      expect((await shown(await get(query(), "s-user", "en-US,zh;q=0.9"))).html).toContain(
        '<html lang="en">',
      );
    },
    T,
  );

  it(
    "a disabled user, or one without a tenant: a page",
    async () => {
      expect((await get(query(), "s-disabled")).status).toBe(403);
      expect((await get(query(), "s-no-tenant")).status).toBe(403);
    },
    T,
  );
});

describe("the answer", () => {
  it(
    "a form token is good once, and only for the sign-in it was shown to",
    async () => {
      const q = query();
      const a = await shown(await get(q, "s-user"));
      // Another sign-in of the same user: refused, and the token is used up.
      expect((await post(q, "s-user-2", allow(a.token))).status).toBe(403);
      expect((await post(q, "s-user", allow(a.token))).status).toBe(403);
      const b = await shown(await get(q, "s-user"));
      expect((await post(q, "s-user", allow(b.token))).status).toBe(302);
      expect((await post(q, "s-user", allow(b.token))).status).toBe(403);
      expect((await post(q, "s-user", allow("not-a-token"))).status).toBe(403);
      expect((await post(q, "s-user", "decision=allow&scope=saveslot.read&name=x")).status).toBe(
        403,
      );
    },
    T,
  );

  it(
    "a form token is good only for the request its page was shown for",
    async () => {
      // The page of a read-only request; its token sent with another query (another redirect URI
      // and challenge, more scopes): refused, and used up.
      const readOnly = query({ scope: "saveslot.read" });
      const a = await shown(await get(readOnly, "s-user"));
      const other = query({
        scope: "saveslot.read saveslot.write",
        code_challenge: "A".repeat(43),
      });
      expect((await post(other, "s-user", allow(a.token))).status).toBe(403);
      expect((await post(readOnly, "s-user", allow(a.token))).status).toBe(403);
    },
    T,
  );

  it(
    "a login with less time left than a code lasts: the sign-in starts again, on GET",
    async () => {
      const q = query();
      const r = await get(q, "s-user-ending");
      expect(r.status).toBe(302);
      expect(loginsBegun).toEqual([`/oauth/authorize?${q}`]);
      expect(new URL(r.headers.get("location") as string, base).pathname).toBe("/account/login");
      // Exactly a code's lifetime left is enough.
      expect((await get(q, "s-user-60")).status).toBe(200);
    },
    T,
  );

  it(
    "the login nearing its end by the time of the answer: the sign-in starts again, no code",
    async () => {
      const q = query();
      const codes = async () =>
        (await bed.control.read((tx) => tx.query("SELECT 1 FROM oauth_codes"))).rows.length;
      const before = await codes();
      const a = await shown(await get(q, "s-user"));
      const r = await post(q, "s-user-ending", allow(a.token));
      expect(r.status).toBe(302);
      expect(loginsBegun).toEqual([`/oauth/authorize?${q}`]);
      const to = new URL(r.headers.get("location") as string, base);
      expect(to.pathname).toBe("/account/login");
      expect(to.searchParams.has("code")).toBe(false);
      expect(await codes()).toBe(before);
    },
    T,
  );

  it(
    "signed out at the answer: the sign-in starts again, nothing issued",
    async () => {
      const q = query();
      const a = await shown(await get(q, "s-user"));
      const r = await post(q, undefined, allow(a.token));
      expect(r.status).toBe(302);
      expect(loginsBegun).toEqual([`/oauth/authorize?${q}`]);
      expect(new URL(r.headers.get("location") as string, base).pathname).toBe("/account/login");
    },
    T,
  );

  it(
    "deny: access_denied back to the client, no code",
    async () => {
      const q = query();
      const a = await shown(await get(q, "s-user"));
      const r = await post(q, "s-user", `form_token=${encodeURIComponent(a.token)}&decision=deny`);
      expect(r.status).toBe(302);
      const to = new URL(r.headers.get("location") as string);
      expect(Object.fromEntries(to.searchParams)).toEqual({
        error: "access_denied",
        state: "st-1",
        iss: EXT,
      });
    },
    T,
  );

  it.each([
    ["without saveslot.read", "form_token=TOKEN&decision=allow&scope=saveslot.write&name=n"],
    [
      "a scope the request did not offer",
      "form_token=TOKEN&decision=allow&scope=saveslot.read&scope=saveslot.delete&name=n",
    ],
  ])(
    "scopes tampered %s: refused, no code",
    async (_, body) => {
      const q = query();
      const a = await shown(await get(q, "s-user"));
      const r = await post(q, "s-user", body.replace("TOKEN", encodeURIComponent(a.token)));
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
    },
    T,
  );

  it(
    "a name taken: the page again, with the problem and a new form token",
    async () => {
      const q = query();
      const first = await shown(await get(q, "s-user"));
      const name = freshName("Desk");
      const ok = await post(
        q,
        "s-user",
        `form_token=${encodeURIComponent(first.token)}&decision=allow&scope=saveslot.read&name=${encodeURIComponent(name)}`,
      );
      const code = new URL(ok.headers.get("location") as string).searchParams.get("code") as string;
      // Redeemed: the name is now a connection instance's.
      await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: VERIFIER,
          client_id: ID,
          redirect_uri: REDIRECT,
        }).toString(),
      });
      const second = await shown(await get(q, "s-user"));
      const again = await post(
        q,
        "s-user",
        `form_token=${encodeURIComponent(second.token)}&decision=allow&scope=saveslot.read&name=${encodeURIComponent(name)}`,
      );
      expect(again.status).toBe(200);
      const page = await shown(again);
      expect(page.html).toContain("Another connection instance has this name");
      expect(page.token).not.toBe(second.token);
    },
    T,
  );

  it(
    "form fields named __proto__ and constructor are fields like any other",
    async () => {
      const q = query();
      const a = await shown(await get(q, "s-user"));
      const r = await post(q, "s-user", allow(a.token, "&__proto__=1&constructor=2"));
      expect(r.status).toBe(302);
    },
    T,
  );
});

describe("consent to token", () => {
  it(
    "a connection instance: the code redeemed is a credential that expires in an hour",
    async () => {
      const q = query();
      const a = await shown(await get(q, "s-user"));
      const r = await post(q, "s-user", allow(a.token));
      const to = new URL(r.headers.get("location") as string);
      expect(to.searchParams.get("state")).toBe("st-1");
      expect(to.searchParams.get("iss")).toBe(EXT);
      const t = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: to.searchParams.get("code") as string,
          code_verifier: VERIFIER,
          client_id: ID,
          redirect_uri: REDIRECT,
        }).toString(),
      });
      expect(t.status).toBe(200);
      const body = (await t.json()) as { access_token: string; scope: string };
      expect(body.scope).toBe("saveslot.read saveslot.write");
      expect(await bed.cp.credential(tokenHash(body.access_token))).toMatchObject({
        kind: "connection",
        tenant: TENANT,
        expiresAt: "2026-11-21T09:00:00.000Z",
      });
    },
    T,
  );

  it(
    "a client assertion sent along is ignored: a public client's code is redeemed on PKCE alone",
    async () => {
      // A client that prefers private_key_jwt may still send one; it is neither checked nor refused.
      const q = query();
      const a = await shown(await get(q, "s-user"));
      const r = await post(q, "s-user", allow(a.token));
      const t = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: new URL(r.headers.get("location") as string).searchParams.get("code") as string,
          code_verifier: VERIFIER,
          client_id: ID,
          redirect_uri: REDIRECT,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2ln",
        }).toString(),
      });
      expect(t.status).toBe(200);
      const body = (await t.json()) as { access_token: string };
      expect(await bed.cp.credential(tokenHash(body.access_token))).toMatchObject({
        kind: "connection",
        tenant: TENANT,
      });
    },
    T,
  );

  it(
    "the CLI: no name, no scopes; its code is a user session",
    async () => {
      const cli = "http://127.0.0.1:49152/callback";
      const q = query({ client_id: "saveslot-cli", redirect_uri: cli });
      const page = await shown(await get(q, "s-user"));
      expect(page.name).toBeUndefined();
      expect(page.html).not.toContain('name="scope"');
      const r = await post(
        q,
        "s-user",
        `form_token=${encodeURIComponent(page.token)}&decision=allow`,
      );
      const code = new URL(r.headers.get("location") as string).searchParams.get("code") as string;
      const t = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: VERIFIER,
          client_id: "saveslot-cli",
          redirect_uri: cli,
        }).toString(),
      });
      expect(((await t.json()) as { access_token: string }).access_token).toMatch(/^sls_/);
    },
    T,
  );
});
