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
import {
  CLIENT_FETCH_BOUNDS,
  ClientError,
  type ClientFetchBounds,
  ClientFetchLimits,
  type IdentityProvider,
  type IdentityRequest,
  tokenHash,
} from "@fluxvita/saveslot-service";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OAuthTestBed, oauthTestBed } from "../../../service/src/oauth.fixture.ts";
import { testBackend } from "../../../test-backend/src/index.fixture.ts";

import { redirectSource } from "./consent.ts";
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
/** Bounds on fetching client documents for the next request; the bed's when undefined. */
let bounds: ClientFetchBounds | undefined;
let server: Server;
let base: string;
let clientName = "Example <Agent>";
/** The redirect URIs the client document lists. */
let redirects = [REDIRECT];
/** In place of the client document's fetch, when a case sets it: what it answers or throws. */
let fetched: (() => Promise<{ body: Uint8Array }>) | undefined;
/** The request log lines of the OAuth routes. */
const logged: Record<string, string | number>[] = [];
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
    fetchClient: async () =>
      fetched !== undefined
        ? fetched()
        : {
            body: new TextEncoder().encode(
              JSON.stringify({ client_id: ID, client_name: clientName, redirect_uris: redirects }),
            ),
          },
  });
  // The CLI's code is redeemed from the login it was consented under.
  bed.logins.set("session-1", USER);
  const deps = bed.deps;
  server = createServer((req, res) => {
    handleOAuth(req, res, {
      deps: bounds === undefined ? deps : { ...deps, clientFetches: new ClientFetchLimits(bounds) },
      identity,
      remote: () => "127.0.0.1",
      now: () => NOW,
      log: (f) => logged.push({ ...f }),
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
  fetched = undefined;
  logged.length = 0;
  clientName = "Example <Agent>";
  redirects = [REDIRECT];
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

/** The pages' policy; `formSource`, where the consent page's forms may go besides this service. */
const csp = (formSource?: string) =>
  `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'${formSource === undefined ? "" : ` ${formSource}`}; frame-ancestors 'none'; base-uri 'none'`;

/** Headers of a page; its forms go to this service only unless `formSource` is given. */
function expectPageHeaders(r: Response, formSource?: string) {
  expect(r.headers.get("content-security-policy")).toBe(csp(formSource));
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("cache-control")).toBe("no-store");
  // Not no-referrer: under it a browser posts the page's forms with `Origin: null`.
  expect(r.headers.get("referrer-policy")).toBe("same-origin");
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

describe("fetching the client document bounded: its own page, not the client's error", () => {
  it.each<[string, Partial<ClientFetchBounds>, number, string]>([
    ["past the source's fetches", { perSource: 0 }, 429, "Too many requests"],
    ["fetches under way at their bound", { concurrent: 0 }, 503, "saveslot is busy"],
  ])(
    "%s: %i",
    async (_, b, status, text) => {
      bounds = { ...CLIENT_FETCH_BOUNDS, ...b };
      try {
        const r = await get(query(), "s-user");
        expect(r.status).toBe(status);
        expect(r.headers.get("location")).toBeNull();
        expect(await r.text()).toContain(text);
      } finally {
        bounds = undefined;
      }
    },
    T,
  );
});

describe("a client refused: why, in the request's log line; the page as before", () => {
  const doc = (o: Record<string, unknown>) => async () => ({
    body: new TextEncoder().encode(
      JSON.stringify({ client_id: ID, redirect_uris: [REDIRECT], ...o }),
    ),
  });
  const throws =
    (code: ConstructorParameters<typeof ClientError>[0], status?: number) => async () => {
      throw new ClientError(code, "client document: refused", status);
    };
  it.each<[string, () => Promise<{ body: Uint8Array }>, Record<string, string | number>]>([
    [
      "the host answered 403",
      throws("fetch_failed", 403),
      { client_problem: "fetch_failed", client_status: 403 },
    ],
    ["no answer", throws("fetch_failed"), { client_problem: "fetch_failed" }],
    [
      "an address that is not public",
      throws("address_refused"),
      { client_problem: "address_refused" },
    ],
    ["too large", throws("document_too_large"), { client_problem: "document_too_large" }],
    [
      "not JSON",
      async () => ({ body: new TextEncoder().encode("<html>a challenge</html>") }),
      { client_problem: "document_malformed" },
    ],
    [
      "another client_id",
      doc({ client_id: "https://other.example/c.json" }),
      { client_problem: "client_id_mismatch" },
    ],
    ["no redirect URIs", doc({ redirect_uris: [] }), { client_problem: "redirect_uris_missing" }],
    [
      "a redirect URI not usable",
      doc({ redirect_uris: ["not a uri"] }),
      { client_problem: "redirect_uri_malformed" },
    ],
    [
      "a confidential client",
      doc({ token_endpoint_auth_method: "client_secret_basic" }),
      { client_problem: "auth_method_unsupported" },
    ],
    [
      "no authorization code",
      doc({ grant_types: ["client_credentials"] }),
      { client_problem: "grant_type_unsupported" },
    ],
  ])(
    "%s",
    async (_, answer, why) => {
      fetched = answer;
      const r = await get(query(), "s-user");
      expect(r.status).toBe(400);
      const page = await r.text();
      // The page the user sees says what it always said, and nothing of why.
      expect(entities(page)).toContain("This app's client ID isn't one saveslot can use.");
      expect(page).not.toContain(String(why["client_problem"]));
      const line = logged.at(-1);
      expect(line).toMatchObject({ method: "GET", route: "oauth.authorize", status: 400, ...why });
      if (why["client_status"] === undefined) expect(line).not.toHaveProperty("client_status");
    },
    T,
  );

  it(
    "a client ID that is not a document URL: its code, nothing fetched",
    async () => {
      fetched = async () => {
        throw new Error("not fetched");
      };
      expect(
        (await get(query({ client_id: "http://client.example/c.json" }), "s-user")).status,
      ).toBe(400);
      expect(logged.at(-1)).toMatchObject({
        route: "oauth.authorize",
        client_problem: "client_id_malformed",
      });
    },
    T,
  );

  it.each<[string, Partial<ClientFetchBounds>, number, string]>([
    ["past the source's fetches", { perSource: 0 }, 429, "fetch_limited"],
    ["fetches under way at their bound", { concurrent: 0 }, 503, "fetch_busy"],
  ])(
    "%s: its code with its own status",
    async (_, b, status, problem) => {
      bounds = { ...CLIENT_FETCH_BOUNDS, ...b };
      try {
        expect((await get(query(), "s-user")).status).toBe(status);
        expect(logged.at(-1)).toMatchObject({
          route: "oauth.authorize",
          status,
          client_problem: problem,
        });
      } finally {
        bounds = undefined;
      }
    },
    T,
  );

  it(
    "a client that passes: no client_problem in the line",
    async () => {
      await get(query(), "s-user");
      expect(logged.at(-1)).toMatchObject({ route: "oauth.authorize" });
      expect(logged.at(-1)).not.toHaveProperty("client_problem");
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
      expectPageHeaders(r, "https://client.example");
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
    "the client's host is shown as plainly as its name: both in bold",
    async () => {
      for (const lang of ["en", "zh-CN"]) {
        const { html } = await shown(await get(query(), "s-user", lang));
        expect(html, lang).toContain("<strong>Example &lt;Agent&gt;</strong>");
        expect(html, lang).toContain("<strong>client.example</strong>");
      }
    },
    T,
  );

  it(
    "who answers and where the answer goes: in the form, right above its buttons, for a client and the CLI",
    async () => {
      const cli = query({
        client_id: "saveslot-cli",
        redirect_uri: "http://127.0.0.1:49152/callback",
      });
      for (const [q, host] of [
        [query(), "client.example"],
        [cli, "127.0.0.1:49152"],
      ] as const) {
        for (const [lang, who, back] of [
          ["en", "Signed in as Alex &lt;Example&gt;.", `You will return to ${host}.`],
          ["zh-CN", "当前登录：Alex &lt;Example&gt;。", `完成后回到 ${host}。`],
        ] as const) {
          const { html } = await shown(await get(q, "s-user", lang));
          const form = /<form [^>]*>([\s\S]*?)<\/form>/.exec(html)?.[1] ?? "";
          const line = /<p class="fine">([^<]*)<\/p>\n<div class="actions">/.exec(form)?.[1] ?? "";
          expect(line, `${host} ${lang}`).toContain(who);
          expect(line, `${host} ${lang}`).toContain(back);
        }
      }
    },
    T,
  );

  it(
    "a client asking for all four scopes: all four offered, only read and write ticked",
    async () => {
      const q = query({ scope: "saveslot.read saveslot.write saveslot.schema saveslot.delete" });
      const { html } = await shown(await get(q, "s-user"));
      expect(html).toContain('name="scope" value="saveslot.write" checked');
      expect(html).toContain('name="scope" value="saveslot.schema">');
      expect(html).toContain('name="scope" value="saveslot.delete">');
      expect(html.match(/ checked/g)).toHaveLength(2);
      // Asked for read and schema only: schema offered, nothing but read ticked.
      const narrow = await shown(
        await get(query({ scope: "saveslot.read saveslot.schema" }), "s-user"),
      );
      expect(narrow.html).toContain('name="scope" value="saveslot.schema">');
      expect(narrow.html.match(/ checked/g)).toHaveLength(1);
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
    "the page's forms may go to this service and to the origin of the request's redirect URI only",
    async () => {
      // A browser checks the redirect after the answer against form-action too (05
      // «授权页、验证页与它们的错误页的响应头»): without the redirect URI's origin the client never
      // gets its code. Only the origin, or the scheme, is written: never the rest of the URI.
      for (const [uri, source] of [
        ["http://127.0.0.1:61433/callback", "http://127.0.0.1:61433"],
        ["http://localhost:58520/callback", "http://localhost:58520"],
        ["https://client.example:8443/cb?from=app", "https://client.example:8443"],
        ["com.example.app:/oauth/callback", "com.example.app:"],
        ["https://client.example/cb;form-action%20*", "https://client.example"],
        ["https://client.example/cb;form-action *", "https://client.example"],
      ]) {
        redirects = [uri as string];
        await bed.control.write((tx) => tx.exec("DELETE FROM oauth_clients"));
        const r = await get(query({ redirect_uri: uri }), "s-user");
        expect(r.status, uri).toBe(200);
        expectPageHeaders(r, source);
      }
    },
    T,
  );

  it(
    "the page shown again after an answer it refused allows the redirect URI's origin too",
    async () => {
      const q = query();
      const a = await shown(await get(q, "s-user"));
      const r = await post(
        q,
        "s-user",
        `form_token=${encodeURIComponent(a.token)}&decision=allow&scope=saveslot.read&name=`,
      );
      expect(r.status).toBe(200);
      expect((await shown(r)).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expectPageHeaders(r, "https://client.example");
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
      const sent = await post(q, "s-user", allow(b.token));
      expect(sent.status).toBe(302);
      // The redirect to the client carries the code: no referrer goes with it.
      expect(sent.headers.get("referrer-policy")).toBe("no-referrer");
      const again = await post(q, "s-user", allow(b.token));
      expect(again.status).toBe(403);
      expectPageHeaders(again);
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
      expect(page.html).toContain("That name is taken");
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

describe("redirectSource", () => {
  it("is the origin of an http or https URI, the scheme of another, nothing else of the URI", () => {
    expect(redirectSource("http://127.0.0.1:61433/callback")).toBe("http://127.0.0.1:61433");
    expect(redirectSource("https://client.example:443/cb")).toBe("https://client.example");
    expect(redirectSource("https://client.example/cb;x y\nz")).toBe("https://client.example");
    expect(redirectSource("com.example.app:/cb; script-src *")).toBe("com.example.app:");
    expect(redirectSource("not a URI")).toBeUndefined();
  });
});
