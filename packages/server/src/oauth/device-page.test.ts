// The device code's flow over real HTTP on the loopback, on a real control database and tenant (on
// either backend): the CLI starts it, the user approves or denies on the verification page where
// they are signed in, the CLI's poll gets the sign-in. The page: the sign-in through the provider,
// what it says, its headers, its one-time form tokens, and the counts of wrong codes — per sign-in
// and per source, taken before anything is awaited, and never emptied to make room. The identity
// provider is the test's own, signing in by a cookie. Fictional IDs and names.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdentityProvider, IdentityRequest } from "@fluxvita/saveslot-service";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type OAuthTestBed, oauthTestBed } from "../../../service/src/oauth.fixture.ts";
import { testBackend } from "../../../test-backend/src/index.fixture.ts";
import { DeviceTries } from "./device-page.ts";
import { handleOAuth } from "./routes.ts";

const T = 120_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-device-page-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EXT = "https://saveslot.example";
const TENANT = `tn_${"5".repeat(26)}` as const;
const USER = `u_${"4".repeat(26)}` as const;
const NOW = "2026-11-21T08:00:00.000Z";
const VERIFY = "/oauth/device/verify";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Sign-ins whose login has less time left than a code lasts (59 s by the server's clock). */
let ending = new Set<number>();
/**
 * Sign-ins of the stand-in provider, by the value of its `sid` cookie: s-0 … s-9, one user; each
 * has an hour left, but those `ending`.
 */
const signIn = (i: number) => ({
  user: USER,
  session: `session-${i}`,
  name: "Alex <Example>",
  expiresAt: new Date(Date.parse(clock) + (ending.has(i) ? 59 : 3600) * 1000).toISOString(),
});
let loginsBegun: string[] = [];
const identity: IdentityProvider = {
  currentUser: async (req: IdentityRequest) => {
    const m = /^s-(\d)$/.exec(req.cookies.get("sid") ?? "");
    return m === null ? undefined : signIn(Number(m[1]));
  },
  beginLogin: async (_req, returnTo) => {
    loginsBegun.push(returnTo);
    return {
      kind: "redirect",
      location: `/account/login?return_to=${encodeURIComponent(returnTo)}`,
    };
  },
  userState: async () => "active",
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
let tries = new DeviceTries();
let clock = NOW;
/** Moves the server's clock `s` seconds on. */
const tick = (s: number) => {
  clock = new Date(Date.parse(clock) + s * 1000).toISOString();
};

beforeAll(async () => {
  bed = await oauthTestBed({
    backend: testBackend(),
    dir: root,
    tenant: TENANT,
    user: USER,
    now: NOW,
    external: EXT,
    fetchClient: async () => {
      throw new Error("no client document is fetched here");
    },
  });
  server = createServer((req, res) => {
    handleOAuth(req, res, {
      deps: bed.deps,
      identity,
      remote: () => "192.0.2.7",
      now: () => clock,
      log: () => {},
      warn: () => {},
      deviceTries: tries,
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
  ending = new Set();
  // A poll's session is issued from the login that approved the code.
  bed.logins.clear();
  for (let i = 0; i < 10; i++) bed.logins.set(`session-${i}`, USER);
  tries = new DeviceTries();
  clock = NOW;
  await bed.control.write((tx) => tx.exec("DELETE FROM oauth_device_codes; DELETE FROM web_forms"));
});

const FORM = { "content-type": "application/x-www-form-urlencoded" };

async function startDevice(): Promise<{ device_code: string; user_code: string }> {
  const r = await fetch(`${base}/oauth/device`, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({ client_id: "saveslot-cli" }).toString(),
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  return (await r.json()) as { device_code: string; user_code: string };
}

const poll = (deviceCode: string) =>
  fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      grant_type: GRANT,
      device_code: deviceCode,
      client_id: "saveslot-cli",
    }).toString(),
  });

const getPage = (sid: number | undefined, q = "") =>
  fetch(`${base}${VERIFY}${q}`, {
    headers: sid === undefined ? {} : { cookie: `sid=s-${sid}` },
    redirect: "manual",
  });

/** The form token of a page. */
async function formToken(r: Response): Promise<string> {
  const m = /name="form_token" value="([^"]+)"/.exec(await r.text());
  if (m === null) throw new Error("no form token on the page");
  return m[1] as string;
}

const post = (sid: number, fields: Record<string, string>) =>
  fetch(`${base}${VERIFY}`, {
    method: "POST",
    headers: { ...FORM, cookie: `sid=s-${sid}` },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  });

/** A page's form, then its answer with `code` and `decision`. */
async function answer(sid: number, code: string, decision = "approve"): Promise<Response> {
  const token = await formToken(await getPage(sid));
  return post(sid, { form_token: token, user_code: code, decision });
}

describe("the flow", () => {
  it(
    "started by the CLI, approved on the page with the code as typed, polled to a CLI sign-in",
    async () => {
      const d = await startDevice();
      const pending = await poll(d.device_code);
      expect(pending.status).toBe(400);
      expect(await pending.json()).toMatchObject({ error: "authorization_pending" });

      const typed = d.user_code.toLowerCase().replace("-", " ");
      const r = await answer(0, typed);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("The saveslot command line is signed in.");

      // A poll sooner than the interval would be slow_down.
      tick(5);
      const t = await poll(d.device_code);
      expect(t.status).toBe(200);
      expect(t.headers.get("cache-control")).toBe("no-store");
      const body = (await t.json()) as { access_token: string; refresh_token: string };
      expect(body.access_token).toMatch(/^sls_/);
      expect(body.refresh_token).toMatch(/^slr_/);
    },
    T,
  );

  it(
    "denied on the page: the poll gets access_denied",
    async () => {
      const d = await startDevice();
      const r = await answer(0, d.user_code, "deny");
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("The sign-in was denied.");
      expect(await (await poll(d.device_code)).json()).toMatchObject({ error: "access_denied" });
    },
    T,
  );

  it(
    "a login with less time left than a code lasts: the sign-in starts again, on GET",
    async () => {
      ending.add(1);
      const r = await getPage(1, "?user_code=BCDF-GHJK");
      expect(r.status).toBe(302);
      expect(loginsBegun).toEqual([`${VERIFY}?user_code=BCDF-GHJK`]);
    },
    T,
  );

  it(
    "the login nearing its end by the time of the answer: the sign-in starts again, nothing approved",
    async () => {
      const d = await startDevice();
      const token = await formToken(await getPage(2));
      ending.add(2);
      const r = await post(2, { form_token: token, user_code: d.user_code, decision: "approve" });
      expect(r.status).toBe(302);
      expect(loginsBegun).toEqual([VERIFY]);
      tick(5);
      expect(await (await poll(d.device_code)).json()).toMatchObject({
        error: "authorization_pending",
      });
    },
    T,
  );

  it(
    "the poll's session is issued from the login that approved: that one signed out, invalid_grant",
    async () => {
      const d = await startDevice();
      expect((await answer(3, d.user_code)).status).toBe(200);
      // The user's other logins go on; the one that approved has ended.
      bed.logins.delete("session-3");
      tick(5);
      const t = await poll(d.device_code);
      expect(t.status).toBe(400);
      expect(await t.json()).toMatchObject({ error: "invalid_grant" });
    },
    T,
  );

  it(
    "another client cannot start one: invalid_client",
    async () => {
      const r = await fetch(`${base}/oauth/device`, {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ client_id: "https://client.example/c.json" }).toString(),
      });
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ error: "invalid_client" });
    },
    T,
  );
});

describe("the page", () => {
  it(
    "signed out: the sign-in, coming back to the page with its code",
    async () => {
      const r = await getPage(undefined, "?user_code=BCDF-GHJK");
      expect(r.status).toBe(302);
      expect(loginsBegun).toEqual([`${VERIFY}?user_code=BCDF-GHJK`]);
    },
    T,
  );

  it(
    "says it signs the CLI in, shows the code given, escaped; never framed, never cached",
    async () => {
      const r = await getPage(0, `?user_code=${encodeURIComponent('BCDF"><b>')}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
      const html = await r.text();
      expect(html).toContain("This signs the saveslot command line in as you");
      expect(html).toContain("Alex &lt;Example&gt;");
      expect(html).toContain('value="BCDF&quot;&gt;&lt;b&gt;"');
      expect(html).not.toContain("<b>");
      expect(html).toContain('value="approve"');
      expect(html).toContain('value="deny"');
    },
    T,
  );

  it(
    "in Chinese when the browser's first language is",
    async () => {
      const r = await fetch(`${base}${VERIFY}`, {
        headers: { cookie: "sid=s-0", "accept-language": "zh-CN,en;q=0.5" },
      });
      expect(await r.text()).toContain("登录 saveslot 命令行");
    },
    T,
  );

  it(
    "a form token missing, used, or another sign-in's: refused, nothing answered",
    async () => {
      const d = await startDevice();
      expect((await post(0, { user_code: d.user_code, decision: "approve" })).status).toBe(403);
      const token = await formToken(await getPage(0));
      expect(
        (await post(1, { form_token: token, user_code: d.user_code, decision: "approve" })).status,
      ).toBe(403);
      // Used by that try: no good for its own sign-in either.
      expect(
        (await post(0, { form_token: token, user_code: d.user_code, decision: "approve" })).status,
      ).toBe(403);
      expect(await (await poll(d.device_code)).json()).toMatchObject({
        error: "authorization_pending",
      });
    },
    T,
  );

  it(
    "no decision, or another one: refused; fields named __proto__ are fields like others",
    async () => {
      const d = await startDevice();
      const token = await formToken(await getPage(0));
      const r = await fetch(`${base}${VERIFY}`, {
        method: "POST",
        headers: { ...FORM, cookie: "sid=s-0" },
        body: `form_token=${token}&user_code=${d.user_code}&__proto__=x&constructor=y`,
      });
      expect(r.status).toBe(400);
      const token2 = await formToken(await getPage(0));
      expect(
        (await post(0, { form_token: token2, user_code: d.user_code, decision: "allow" })).status,
      ).toBe(400);
    },
    T,
  );
});

describe("wrong codes", () => {
  it(
    "5 per sign-in: then refused, even the right code, while another sign-in still may",
    async () => {
      const d = await startDevice();
      for (let i = 0; i < 5; i++) {
        const r = await answer(0, "BCDF-GHJK");
        expect(r.status).toBe(400);
        expect(await r.text()).toContain("This code is not one that is waiting");
      }
      const limited = await answer(0, d.user_code);
      expect(limited.status).toBe(429);
      expect(await limited.text()).toContain("Too many wrong codes");
      expect((await answer(1, d.user_code)).status).toBe(200);
    },
    T,
  );

  it(
    "20 per source, whatever the sign-in",
    async () => {
      const d = await startDevice();
      for (let s = 0; s < 5; s++) {
        for (let i = 0; i < 4; i++) expect((await answer(s, "zzzz")).status).toBe(400);
      }
      expect((await answer(5, d.user_code)).status).toBe(429);
    },
    T,
  );

  it(
    "a right code is not counted",
    async () => {
      for (let i = 0; i < 4; i++) expect((await answer(0, "BCDF-GHJK")).status).toBe(400);
      const d = await startDevice();
      expect((await answer(0, d.user_code)).status).toBe(200);
      expect((await answer(0, "BCDF-GHJK")).status).toBe(400);
      expect((await answer(0, "BCDF-GHJK")).status).toBe(429);
    },
    T,
  );

  it(
    "20 sent at once from one sign-in: exactly 5 answered as wrong, the rest refused",
    async () => {
      const tokens: string[] = [];
      for (let i = 0; i < 20; i++) tokens.push(await formToken(await getPage(0)));
      const answers = await Promise.all(
        tokens.map((form_token) =>
          post(0, { form_token, user_code: "BCDF-GHJK", decision: "approve" }),
        ),
      );
      const statuses = answers.map((r) => r.status);
      expect(statuses.filter((s) => s === 400)).toHaveLength(5);
      expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    },
    T,
  );
});

describe("the counts", () => {
  const W = 15 * 60_000;

  it("a key at its limit is refused until its window ends; nothing is counted when refused", () => {
    const c = new DeviceTries({ perSignIn: 2, perSource: 3, windowMs: W, cap: 100 });
    expect(c.take("a", "ip", 0)).toBe(true);
    expect(c.take("a", "ip", 1)).toBe(true);
    expect(c.take("a", "ip", 2)).toBe(false);
    // The refused try did not count against the source: one place left of its 3.
    expect(c.take("b", "ip", 3)).toBe(true);
    expect(c.take("c", "ip", 4)).toBe(false);
    expect(c.take("a", "ip", W - 1)).toBe(false);
    // Both windows began at 0: over at W.
    expect(c.take("a", "ip", W)).toBe(true);
  });

  it("full: a new key is refused, and no live key loses its count to make room", () => {
    const c = new DeviceTries({ perSignIn: 2, perSource: 100, windowMs: W, cap: 2 });
    expect(c.take("a", "ip", 0)).toBe(true);
    expect(c.take("b", "ip", 0)).toBe(true);
    // Full of live sign-ins: a third is refused, whatever it sends.
    for (let i = 0; i < 5; i++) expect(c.take(`flood${i}`, "ip", 1)).toBe(false);
    // a's count is still there: one more, then its limit.
    expect(c.take("a", "ip", 2)).toBe(true);
    expect(c.take("a", "ip", 3)).toBe(false);
  });

  it("full of sources: a new source is refused; expired entries make room", () => {
    const c = new DeviceTries({ perSignIn: 100, perSource: 2, windowMs: W, cap: 2 });
    expect(c.take("s", "ip1", 0)).toBe(true);
    expect(c.take("s", "ip2", 0)).toBe(true);
    expect(c.take("s", "ip3", 1)).toBe(false);
    expect(c.take("s", "ip1", 2)).toBe(true);
    expect(c.take("s", "ip3", W)).toBe(true);
  });
});
