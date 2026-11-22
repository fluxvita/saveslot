// `saveslot login` and `logout` (06-cli §2, §4.2) against a stand-in authorization server on
// loopback HTTP: the browser's way (PKCE, state, iss, one callback), the device code's polling,
// the issuer check, where the tokens go, the profile lock, and what a sign-out sends where. The
// server side of these endpoints is the server package's tests' (05-surfaces §15).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUD_SERVER,
  profileCredentialsFile,
  readProfileCredentials,
  readProfiles,
  writeProfileCredentials,
} from "@fluxvita/saveslot-client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileFor, type SignInTesting, signIn } from "./login.ts";
import { signOut } from "./logout.ts";
import { run } from "./run.ts";
import type { StopSignal } from "./setup.ts";
import { TEXTS } from "./texts.ts";

const ACCESS = `sls_${"a".repeat(43)}`;
const REFRESH = `slr_${"r".repeat(43)}`;
const OLD_REFRESH = `slr_${"o".repeat(43)}`;

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly form: URLSearchParams;
}

/** What the stand-in answers; each part replaceable by a test. */
interface Behavior {
  issuer?: (origin: string) => unknown;
  /** The token endpoint's answer to a good code, or to an approved device code. */
  pair?: () => Record<string, unknown>;
  /** The device code's polls, answered in turn (the last one repeats). */
  polls?: (
    | "pending"
    | "slow_down"
    | "access_denied"
    | "expired_token"
    | "temporarily_unavailable"
    | "ok"
  )[];
  device?: (origin: string) => Record<string, unknown>;
  revokeStatus?: number;
  /** The revocation is never answered. */
  revokeHangs?: boolean;
  /** Called as a revocation arrives. */
  onRevoke?: () => void;
  /** The token endpoint answers once this settles. */
  tokenHeld?: Promise<void>;
  /** Called as a token request arrives, before it is answered. */
  onToken?: () => void;
  /** Answers a request in its place when it returns true. */
  instead?: (path: string, res: ServerResponse) => boolean;
}

interface Stand {
  readonly origin: string;
  readonly seen: Seen[];
  /** Codes issued by the authorize step, with the challenge and redirect they were asked with. */
  readonly codes: Map<string, { challenge: string; redirect: string }>;
  behavior: Behavior;
  readonly server: Server;
}

const stands: Stand[] = [];
const roots: string[] = [];

const json = (res: ServerResponse, status: number, v: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

async function stand(behavior: Behavior = {}): Promise<Stand> {
  const seen: Seen[] = [];
  const codes = new Map<string, { challenge: string; redirect: string }>();
  let polled = 0;
  const s: Stand = { origin: "", seen, codes, behavior, server: undefined as never };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      seen.push({ method: req.method ?? "", path: url.pathname, form });
      if (s.behavior.instead?.(url.pathname, res)) return;
      if (url.pathname === "/oauth/token") s.behavior.onToken?.();
      const held = url.pathname === "/oauth/token" ? s.behavior.tokenHeld : undefined;
      void (held ?? Promise.resolve()).then(() => answer(url, form, res));
    });
  });
  const answer = (url: URL, form: URLSearchParams, res: ServerResponse) => {
    const b = s.behavior;
    const pair = () =>
      b.pair?.() ?? {
        access_token: ACCESS,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: REFRESH,
      };
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(res, 200, { issuer: b.issuer ? b.issuer(s.origin) : s.origin });
    } else if (url.pathname === "/oauth/device") {
      json(
        res,
        200,
        b.device?.(s.origin) ?? {
          device_code: "dc-1",
          user_code: "BCDF-GHJK",
          verification_uri: `${s.origin}/oauth/device/verify`,
          verification_uri_complete: `${s.origin}/oauth/device/verify?user_code=BCDF-GHJK`,
          expires_in: 600,
          interval: 5,
        },
      );
    } else if (url.pathname === "/oauth/token") {
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const c = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const hashed = createHash("sha256").update(verifier).digest("base64url");
        if (c === undefined || c.challenge !== hashed || c.redirect !== form.get("redirect_uri")) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        codes.delete(form.get("code") ?? "");
        json(res, 200, pair());
      } else if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        const polls = b.polls ?? ["ok"];
        const p = polls[Math.min(polled++, polls.length - 1)];
        if (p === "ok") json(res, 200, pair());
        else json(res, 400, { error: p === "pending" ? "authorization_pending" : p });
      } else json(res, 400, { error: "unsupported_grant_type" });
    } else if (url.pathname === "/oauth/revoke") {
      b.onRevoke?.();
      if (!b.revokeHangs) res.writeHead(b.revokeStatus ?? 200).end();
    } else json(res, 404, { error: "not_found" });
  };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  Object.assign(s, { origin: `http://127.0.0.1:${port}`, server });
  stands.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stands.splice(0)) {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

let home: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "saveslot-login-"));
  roots.push(root);
  home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
});

/** Plays the user's browser: the authorize step approves and redirects back to the callback. */
function browserAt(s: Stand, o: { state?: string; iss?: string | null; error?: string } = {}) {
  const shown: string[] = [];
  const pages: { status: number; body: string }[] = [];
  let done: Promise<void> = Promise.resolve();
  const open = (url: string) => {
    shown.push(url);
    const u = new URL(url);
    const code = `code-${s.codes.size + 1}`;
    s.codes.set(code, {
      challenge: u.searchParams.get("code_challenge") ?? "",
      redirect: u.searchParams.get("redirect_uri") ?? "",
    });
    const back = new URL(u.searchParams.get("redirect_uri") ?? "");
    if (o.error !== undefined) back.searchParams.set("error", o.error);
    else back.searchParams.set("code", code);
    back.searchParams.set("state", o.state ?? u.searchParams.get("state") ?? "");
    if (o.iss !== null) back.searchParams.set("iss", o.iss ?? s.origin);
    done = fetch(back).then(async (r) => {
      pages.push({ status: r.status, body: await r.text() });
    });
  };
  return { open, shown, pages, settled: () => done };
}

function capture(tty = true) {
  let err = "";
  return {
    io: {
      err: (t: string) => {
        err += t;
      },
      stdinIsTTY: tty,
      stderrIsTTY: tty,
    },
    said: () => err,
  };
}

/** A clock that the stand-in `sleep` moves on, and the waits it was asked for. */
function clock() {
  let t = Date.parse("2026-11-21T10:00:00.000Z");
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

const exists = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

describe("signIn in a browser", () => {
  it("redeems the code with its verifier and writes the pair, 0600, for this server", async () => {
    const s = await stand();
    const b = browserAt(s);
    const c = capture();
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: c.io,
      testing: { openBrowser: b.open },
    });
    expect(r).toEqual({ ok: true, mode: "browser" });
    const file = profileCredentialsFile(home, "lab");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = await readProfileCredentials(home, "lab");
    expect(written).toMatchObject({
      server: s.origin,
      access_token: ACCESS,
      refresh_token: REFRESH,
    });
    // The authorize address: PKCE S256, a loopback callback, the CLI's client and the resource.
    const asked = new URL(b.shown[0] as string);
    expect(asked.origin + asked.pathname).toBe(`${s.origin}/oauth/authorize`);
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
    expect(asked.searchParams.get("client_id")).toBe("saveslot-cli");
    expect(asked.searchParams.get("resource")).toBe(s.origin);
    expect(asked.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The address is printed as well as opened.
    expect(c.said()).toContain(asked.href);
    await b.settled();
    expect(b.pages).toEqual([{ status: 200, body: `${TEXTS.loginPageDone}\n` }]);
  });

  it("sends client_id and resource with the code, and no token to anyone but the server", async () => {
    const s = await stand();
    const b = browserAt(s);
    const c = capture();
    await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: c.io,
      testing: { openBrowser: b.open },
    });
    const tokenCalls = s.seen.filter((x) => x.path === "/oauth/token");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.form.get("client_id")).toBe("saveslot-cli");
    expect(tokenCalls[0]?.form.get("resource")).toBe(s.origin);
    expect(c.said()).not.toMatch(/sl[sr]_/);
  });

  it("a callback with another state: 400, no code redeemed, and the wait goes on", async () => {
    const s = await stand();
    const b = browserAt(s, { state: "not-this-one" });
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: { openBrowser: b.open, callbackWaitMs: 300 },
    });
    // Not taken as this sign-in's answer: it ends only when the wait does.
    expect(r).toEqual({ ok: false, exit: 8, message: TEXTS.loginTimedOut });
    expect(s.seen.filter((x) => x.path === "/oauth/token")).toEqual([]);
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
    await b.settled();
    expect(b.pages).toEqual([{ status: 400, body: `${TEXTS.loginPageNotThis}\n` }]);
  });

  it("a forged callback first, then the real one: the sign-in goes through", async () => {
    const s = await stand();
    const forged = browserAt(s, { state: "forged" });
    const real = browserAt(s);
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: {
        openBrowser: (url) => {
          forged.open(url);
          void forged.settled().then(() => real.open(url));
        },
      },
    });
    expect(r).toEqual({ ok: true, mode: "browser" });
    await real.settled();
    expect(forged.pages).toEqual([{ status: 400, body: `${TEXTS.loginPageNotThis}\n` }]);
    expect(real.pages).toEqual([{ status: 200, body: `${TEXTS.loginPageDone}\n` }]);
    expect(s.seen.filter((x) => x.path === "/oauth/token")).toHaveLength(1);
    expect(await readProfileCredentials(home, "lab")).toMatchObject({ access_token: ACCESS });
  });

  it.each([
    ["another issuer", "https://elsewhere.example"],
    ["no iss", null],
  ])("a callback with %s: refused (RFC 9207)", async (_, iss) => {
    const s = await stand();
    const b = browserAt(s, { iss });
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: { openBrowser: b.open },
    });
    expect(r).toEqual({ ok: false, exit: 6, message: TEXTS.loginIssuerMismatch });
    expect(s.seen.filter((x) => x.path === "/oauth/token")).toEqual([]);
  });

  it("declined on the page: not done (exit 8), nothing written", async () => {
    const s = await stand();
    const b = browserAt(s, { error: "access_denied" });
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: { openBrowser: b.open },
    });
    expect(r).toEqual({ ok: false, exit: 8, message: TEXTS.loginDenied });
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("refused on the page by the server, not by the person: exit 6, nothing written", async () => {
    const s = await stand();
    const b = browserAt(s, { error: "invalid_scope" });
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: { openBrowser: b.open },
    });
    expect(r).toEqual({ ok: false, exit: 6, message: TEXTS.loginRefused });
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("the token endpoint refusing the code: exit 6", async () => {
    const s = await stand();
    const b = browserAt(s);
    // The code the browser brought back is unknown to the token endpoint.
    const open = (url: string) => {
      b.open(url);
      s.codes.clear();
    };
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: { openBrowser: open },
    });
    expect(r).toEqual({ ok: false, exit: 6, message: TEXTS.loginRefused });
  });

  it("takes one callback: a second gets 400, and no page says anything of the tokens", async () => {
    // The token endpoint answers only once a second callback has been tried.
    let release: () => void = () => {};
    const s = await stand({
      tokenHeld: new Promise<void>((r) => {
        release = r;
      }),
    });
    const b = browserAt(s);
    const second: { status: number; body: string }[] = [];
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: {
        openBrowser: (url) => {
          b.open(url);
          const u = new URL(url);
          const again = new URL(u.searchParams.get("redirect_uri") ?? "");
          again.searchParams.set("code", "code-other");
          again.searchParams.set("state", u.searchParams.get("state") ?? "");
          again.searchParams.set("iss", s.origin);
          void b
            .settled()
            .then(() => fetch(again))
            .then(async (x) => {
              second.push({ status: x.status, body: await x.text() });
            })
            .finally(release);
        },
      },
    });
    expect(r).toEqual({ ok: true, mode: "browser" });
    expect(second).toEqual([{ status: 400, body: `${TEXTS.loginPageUsed}\n` }]);
    expect(b.pages).toEqual([{ status: 200, body: `${TEXTS.loginPageDone}\n` }]);
    expect(s.seen.filter((x) => x.path === "/oauth/token")).toHaveLength(1);
    for (const p of [...second, ...b.pages]) expect(p.body).not.toMatch(/sl[sr]_|code-/);
  });

  it("no callback within the wait: not done (exit 8), and the listener is closed", async () => {
    const s = await stand();
    let redirect = "";
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: {
        openBrowser: (url) => {
          redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
        },
        callbackWaitMs: 50,
      },
    });
    expect(r).toEqual({ ok: false, exit: 8, message: TEXTS.loginTimedOut });
    await expect(fetch(redirect)).rejects.toThrow();
  });

  it("stopped while waiting: 130, the listener closed, nothing written", async () => {
    const s = await stand();
    const stop = new AbortController();
    let redirect = "";
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      stop: stop.signal,
      testing: {
        openBrowser: (url) => {
          redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
          setTimeout(() => stop.abort(), 20);
        },
      },
    });
    expect(r).toEqual({ ok: false, exit: 130, message: TEXTS.loginStopped });
    await expect(fetch(redirect)).rejects.toThrow();
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("stopped while the code is redeemed: 130, the tokens not written", async () => {
    const stop = new AbortController();
    const s = await stand({ onToken: () => stop.abort() });
    const b = browserAt(s);
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      stop: stop.signal,
      testing: { openBrowser: b.open },
    });
    expect(r).toEqual({ ok: false, exit: 130, message: TEXTS.loginStopped });
    expect(s.seen.filter((x) => x.path === "/oauth/token")).toHaveLength(1);
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("asked for a browser with no terminal: none opened, the address printed and waited on", async () => {
    const s = await stand();
    const b = browserAt(s);
    let opened = 0;
    const c = capture(false);
    const signing = signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: c.io,
      mode: "browser",
      testing: {
        openBrowser: () => {
          opened++;
        },
      },
    });
    // The person opens the printed address by hand.
    for (let i = 0; i < 100 && !c.said().includes("/oauth/authorize"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const printed = c.said().match(/http:\/\/\S+\/oauth\/authorize\S*/)?.[0] as string;
    b.open(printed);
    expect(await signing).toEqual({ ok: true, mode: "browser" });
    expect(opened).toBe(0);
  });
});

describe("the process, once a sign-in is done", () => {
  const CHILD = fileURLToPath(new URL("./login-child.fixture.ts", import.meta.url));
  /** Runs the sign-in in a process of its own; killed if still running `limitMs` after `go`. */
  function child(origin: string, mode: "browser" | "device") {
    const p = spawn(process.execPath, ["--conditions=source", CHILD, home, origin, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    p.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const ended = new Promise<number | null>((r) => p.on("close", (code) => r(code)));
    return {
      err: () => err,
      /** The exit code, or "running" when it had not ended within `limitMs`. */
      end: async (limitMs: number) => {
        const timer = setTimeout(() => p.kill(), limitMs);
        const killed = new Promise<"running">((r) => p.on("exit", (_, sig) => sig && r("running")));
        const code = await Promise.race([ended, killed]);
        clearTimeout(timer);
        return { code, out };
      },
    };
  }

  it("in a browser: the process ends right after", async () => {
    const s = await stand();
    const b = browserAt(s);
    const c = child(s.origin, "browser");
    for (let i = 0; i < 1000 && !c.err().includes("/oauth/authorize"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    b.open(c.err().match(/http:\/\/\S+\/oauth\/authorize\S*/)?.[0] as string);
    const r = await c.end(5_000);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, mode: "browser" });
  }, 30_000);

  it("with a device code: the process ends right after", async () => {
    const s = await stand({ polls: ["pending", "ok"] });
    s.behavior.device = (origin) => ({
      device_code: "dc-1",
      user_code: "BCDF-GHJK",
      verification_uri: `${origin}/oauth/device/verify`,
      expires_in: 600,
      interval: 1,
    });
    const c = child(s.origin, "device");
    // Two polls a second apart, then the end.
    const r = await c.end(8_000);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, mode: "device" });
  }, 30_000);
});

describe("signIn before any sign-in request", () => {
  it.each([
    ["with a trailing slash", (o: string) => `${o}/`],
    ["of another host", () => "https://elsewhere.example"],
    ["missing", () => undefined],
  ])("an issuer %s: exit 6, nothing sent but the metadata request", async (_, issuer) => {
    const s = await stand({ issuer });
    const b = browserAt(s);
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture().io,
      testing: { openBrowser: b.open },
    });
    expect(r).toEqual({ ok: false, exit: 6, message: TEXTS.loginIssuerMismatch });
    expect(s.seen.map((x) => x.path)).toEqual(["/.well-known/oauth-authorization-server"]);
    expect(b.shown).toEqual([]);
  });

  it("a server not reachable: 7", async () => {
    const s = await stand();
    const gone = s.origin;
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
    stands.splice(stands.indexOf(s), 1);
    const r = await signIn({ home, profile: "lab", server: gone, io: capture().io });
    expect(r).toEqual({ ok: false, exit: 7, message: TEXTS.loginUnreachable });
  });

  it.each([
    ["503 with the contract's unavailable", 503, '{"error":{"code":"unavailable","message":"x"}}'],
    [
      "429 with the contract's rate_limited",
      429,
      '{"error":{"code":"rate_limited","message":"x"}}',
    ],
    ["a proxy's 429 that is no JSON", 429, "<html>Too Many Requests</html>"],
    ["a proxy's 502 that is no JSON", 502, "<html>Bad Gateway</html>"],
  ])("the server busy (%s): 7, try again later", async (_, status, body) => {
    const s = await stand({
      instead: (path, res) => {
        if (path !== "/.well-known/oauth-authorization-server") return false;
        res.writeHead(status, { "content-type": "text/plain" }).end(body);
        return true;
      },
    });
    const r = await signIn({ home, profile: "lab", server: s.origin, io: capture().io });
    expect(r).toEqual({ ok: false, exit: 7, message: TEXTS.loginBusy });
  });

  it("an error answer of no form that is not a busy status: 1", async () => {
    const s = await stand({
      instead: (path, res) => {
        if (path !== "/.well-known/oauth-authorization-server") return false;
        res.writeHead(500, { "content-type": "text/plain" }).end("<html>oops</html>");
        return true;
      },
    });
    const r = await signIn({ home, profile: "lab", server: s.origin, io: capture().io });
    expect(r).toEqual({ ok: false, exit: 1, message: TEXTS.loginBadAnswer });
  });

  it.each([
    ["local", "local"],
    ["not a name", "Lab!"],
  ])("a profile %s: a usage error, nothing sent", async (_, profile) => {
    const s = await stand();
    const r = await signIn({ home, profile, server: s.origin, io: capture().io });
    expect(r).toMatchObject({ ok: false, exit: 2 });
    expect(s.seen).toEqual([]);
  });
});

describe("signIn with a device code", () => {
  it("is the default with no terminal; waits through pending and slow_down, then writes", async () => {
    const s = await stand({ polls: ["pending", "slow_down", "pending", "ok"] });
    const t = clock();
    let opened = 0;
    const c = capture(false);
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: c.io,
      testing: {
        now: t.now,
        sleep: t.sleep,
        openBrowser: () => {
          opened++;
        },
      },
    });
    expect(r).toEqual({ ok: true, mode: "device" });
    expect(opened).toBe(0);
    // 5 s at first; a slow_down adds 5 s to every wait after it.
    expect(t.waits).toEqual([5000, 5000, 10000, 10000]);
    expect(c.said()).toContain("BCDF-GHJK");
    expect(c.said()).toContain(`${s.origin}/oauth/device/verify`);
    const polls = s.seen.filter((x) => x.path === "/oauth/token");
    expect(polls).toHaveLength(4);
    for (const p of [...polls, ...s.seen.filter((x) => x.path === "/oauth/device")]) {
      expect(p.form.get("client_id")).toBe("saveslot-cli");
      expect(p.form.get("resource")).toBe(s.origin);
    }
    expect(polls[0]?.form.get("device_code")).toBe("dc-1");
    expect(await readProfileCredentials(home, "lab")).toMatchObject({ access_token: ACCESS });
  });

  it.each([
    ["access_denied", TEXTS.loginDenied],
    ["expired_token", TEXTS.loginExpired],
  ] as const)("%s: not done (exit 8), nothing written", async (code, message) => {
    const s = await stand({ polls: ["pending", code] });
    const t = clock();
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture(false).io,
      testing: { now: t.now, sleep: t.sleep },
    });
    expect(r).toEqual({ ok: false, exit: 8, message });
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("temporarily_unavailable while polling: 7, nothing written", async () => {
    const s = await stand({ polls: ["pending", "temporarily_unavailable"] });
    const t = clock();
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture(false).io,
      testing: { now: t.now, sleep: t.sleep },
    });
    expect(r).toEqual({ ok: false, exit: 7, message: TEXTS.loginBusy });
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("stopped while the approved poll is out: 130, the tokens not written", async () => {
    const stop = new AbortController();
    const s = await stand({ onToken: () => stop.abort() });
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture(false).io,
      stop: stop.signal,
      testing: { sleep: async () => {} },
    });
    expect(r).toEqual({ ok: false, exit: 130, message: TEXTS.loginStopped });
    expect(s.seen.filter((x) => x.path === "/oauth/token")).toHaveLength(1);
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("an interval past a minute is waited as a minute, slow_down included", async () => {
    const s = await stand({ polls: ["slow_down", "pending", "ok"] });
    s.behavior.device = (origin) => ({
      device_code: "dc-1",
      user_code: "BCDF-GHJK",
      verification_uri: `${origin}/oauth/device/verify`,
      expires_in: 600,
      interval: 10_000_000,
    });
    const t = clock();
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture(false).io,
      testing: { now: t.now, sleep: t.sleep },
    });
    expect(r).toEqual({ ok: true, mode: "device" });
    expect(t.waits).toEqual([60_000, 60_000, 60_000]);
  });

  it("a code said to last past an hour is polled for an hour", async () => {
    const s = await stand({ polls: ["pending"] });
    s.behavior.device = (origin) => ({
      device_code: "dc-1",
      user_code: "BCDF-GHJK",
      verification_uri: `${origin}/oauth/device/verify`,
      expires_in: 1_000_000_000,
      interval: 60,
    });
    const t = clock();
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture(false).io,
      testing: { now: t.now, sleep: t.sleep },
    });
    expect(r).toEqual({ ok: false, exit: 8, message: TEXTS.loginExpired });
    // 3600 s at 60 s apart: the poll that would come at 3600 s is not made.
    expect(s.seen.filter((x) => x.path === "/oauth/token")).toHaveLength(59);
  }, 30_000);

  it.each([
    [
      "no terminal: tagged",
      false,
      (n: string, u: string) => `<untrusted-data-${n}>${u}</untrusted-data-${n}>`,
    ],
    ["a terminal: in 「」", true, (_: string, u: string) => `「${u}」`],
  ])(
    "the pages printed are the server's words, inside the boundary (%s)",
    async (_, tty, inside) => {
      const s = await stand();
      const c = capture(tty);
      const r = await signIn({
        home,
        profile: "lab",
        server: s.origin,
        io: c.io,
        mode: "device",
        testing: { sleep: async () => {} },
      });
      expect(r).toEqual({ ok: true, mode: "device" });
      const n = c.said().match(/<untrusted-data-([0-9a-f]{32})>/)?.[1] ?? "";
      expect(c.said()).toContain(inside(n, `${s.origin}/oauth/device/verify`));
      expect(c.said()).toContain(inside(n, `${s.origin}/oauth/device/verify?user_code=BCDF-GHJK`));
      // The user code has its shape checked: written as it is.
      expect(c.said()).toContain(`${TEXTS.loginDeviceCode} BCDF-GHJK\n`);
    },
  );

  it("past the code's expiry by the local clock: not done (exit 8), no further poll", async () => {
    const s = await stand({ polls: ["pending"] });
    const t = clock();
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture(false).io,
      testing: { now: t.now, sleep: t.sleep },
    });
    expect(r).toEqual({ ok: false, exit: 8, message: TEXTS.loginExpired });
    // 600 s at 5 s apart: the poll that would come at 600 s is not made.
    expect(s.seen.filter((x) => x.path === "/oauth/token")).toHaveLength(119);
  });

  it("stopped while polling: 130", async () => {
    const s = await stand({ polls: ["pending"] });
    const stop = new AbortController();
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture(false).io,
      stop: stop.signal,
      testing: {
        sleep: () => {
          stop.abort();
          return new Promise(() => {});
        },
      },
    });
    expect(r).toEqual({ ok: false, exit: 130, message: TEXTS.loginStopped });
  });

  it.each([
    ["a page on another host", { verification_uri: "https://elsewhere.example/verify" }],
    ["a user code not of the form", { user_code: "bcdf-ghjk\u001b[2J" }],
    ["no device code", { device_code: "" }],
  ])("a device answer with %s: exit 1, nothing printed of it", async (_, change) => {
    const s = await stand();
    s.behavior.device = (origin) => ({
      device_code: "dc-1",
      user_code: "BCDF-GHJK",
      verification_uri: `${origin}/oauth/device/verify`,
      expires_in: 600,
      interval: 5,
      ...change,
    });
    const c = capture(false);
    const r = await signIn({ home, profile: "lab", server: s.origin, io: c.io });
    expect(r).toEqual({ ok: false, exit: 1, message: TEXTS.loginBadAnswer });
    expect(c.said()).not.toContain("elsewhere");
    expect(c.said()).not.toContain("\u001b");
  });
});

describe("signIn's write", () => {
  const device = async (s: Stand, testing: SignInTesting = {}) =>
    signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: capture(false).io,
      testing: { sleep: async () => {}, ...testing },
    });

  it.each([
    ["an access token not of the form", { access_token: "sls_short" }],
    ["a refresh token not of the form", { refresh_token: "slt_".padEnd(47, "x") }],
    ["no expires_in", { expires_in: undefined }],
    ["a fractional expires_in", { expires_in: 1.5 }],
  ])("a token answer with %s: exit 1, nothing written", async (_, change) => {
    const s = await stand({
      pair: () => ({ access_token: ACCESS, expires_in: 3600, refresh_token: REFRESH, ...change }),
    });
    expect(await device(s)).toEqual({ ok: false, exit: 1, message: TEXTS.loginBadAnswer });
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("credentials/ open to others: the permissions error, not a bad answer", async () => {
    const s = await stand();
    mkdirSync(join(home, "credentials"), { mode: 0o700 });
    await chmod(join(home, "credentials"), 0o755);
    expect(await device(s)).toEqual({
      ok: false,
      exit: 6,
      message: TEXTS.credential("permissions"),
    });
  });

  it("the profile's lock held by another command: waited for, then busy (exit 7, as setup's lock)", async () => {
    const s = await stand();
    mkdirSync(join(home, "credentials"), { mode: 0o700 });
    const lock = `${profileCredentialsFile(home, "lab")}.lock`;
    writeFileSync(lock, "1 held\n", { mode: 0o600 });
    const began = Date.now();
    expect(await device(s, { lock: { waitMs: 200 } })).toEqual({
      ok: false,
      exit: 7,
      message: TEXTS.credential("busy"),
    });
    expect(Date.now() - began).toBeGreaterThanOrEqual(200);
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("a lock older than 30 s: taken as left behind, and the pair written", async () => {
    const s = await stand();
    mkdirSync(join(home, "credentials"), { mode: 0o700 });
    const lock = `${profileCredentialsFile(home, "lab")}.lock`;
    writeFileSync(lock, "1 left\n", { mode: 0o600 });
    const old = (Date.now() - 31_000) / 1000;
    utimesSync(lock, old, old);
    expect(await device(s, { lock: { waitMs: 200 } })).toEqual({ ok: true, mode: "device" });
    expect(exists(lock)).toBe(false);
  });

  const older = (server: string) =>
    writeProfileCredentials(home, "lab", {
      server,
      access_token: ACCESS,
      access_expires_at: "2026-11-21T09:00:00.000Z",
      refresh_token: OLD_REFRESH,
    });

  it("replaces an older sign-in of the profile, then revokes its refresh token", async () => {
    const s = await stand();
    await older(s.origin);
    expect(await device(s)).toEqual({ ok: true, mode: "device" });
    expect((await readProfileCredentials(home, "lab"))?.refresh_token).toBe(REFRESH);
    const revokes = s.seen.filter((x) => x.path === "/oauth/revoke");
    expect(revokes.map((x) => Object.fromEntries(x.form))).toEqual([
      { token: OLD_REFRESH, token_type_hint: "refresh_token", client_id: "saveslot-cli" },
    ]);
    // After the new pair is in the file, not before.
    const order = s.seen.map((x) => x.path);
    expect(order.lastIndexOf("/oauth/token")).toBeLessThan(order.indexOf("/oauth/revoke"));
  });

  it("the older sign-in's revocation is sent with the profile's lock released", async () => {
    const lockHeld: boolean[] = [];
    const s = await stand({
      onRevoke: () => lockHeld.push(exists(`${profileCredentialsFile(home, "lab")}.lock`)),
    });
    await older(s.origin);
    expect(await device(s)).toEqual({ ok: true, mode: "device" });
    expect(lockHeld).toEqual([false]);
  });

  it("an older sign-in of another server: replaced, its token sent nowhere", async () => {
    const s = await stand();
    const other = await stand();
    await older(other.origin);
    expect(await device(s)).toEqual({ ok: true, mode: "device" });
    expect(s.seen.filter((x) => x.path === "/oauth/revoke")).toEqual([]);
    expect(other.seen).toEqual([]);
    expect((await readProfileCredentials(home, "lab"))?.server).toBe(s.origin);
  });

  it("the older sign-in's revocation failing: said once, the sign-in still done", async () => {
    const s = await stand({ revokeStatus: 503 });
    await older(s.origin);
    const c = capture(false);
    const r = await signIn({
      home,
      profile: "lab",
      server: s.origin,
      io: c.io,
      testing: { sleep: async () => {} },
    });
    expect(r).toEqual({ ok: true, mode: "device" });
    expect(c.said().split(TEXTS.loginOldNotRevoked)).toHaveLength(2);
    expect((await readProfileCredentials(home, "lab"))?.refresh_token).toBe(REFRESH);
  });
});

describe("signOut", () => {
  const signedIn = (server: string) =>
    writeProfileCredentials(home, "lab", {
      server,
      access_token: ACCESS,
      access_expires_at: "2026-11-21T09:00:00.000Z",
      refresh_token: OLD_REFRESH,
    });

  it("revokes the refresh token at the profile's server, then removes the file", async () => {
    const s = await stand();
    await signedIn(s.origin);
    expect(await signOut({ home, profile: "lab", server: s.origin })).toBe("revoked");
    const revokes = s.seen.filter((x) => x.path === "/oauth/revoke");
    expect(revokes.map((x) => Object.fromEntries(x.form))).toEqual([
      { token: OLD_REFRESH, token_type_hint: "refresh_token", client_id: "saveslot-cli" },
    ]);
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("the server refusing or not reachable: said, and the file removed all the same", async () => {
    const s = await stand({ revokeStatus: 503 });
    await signedIn(s.origin);
    expect(await signOut({ home, profile: "lab", server: s.origin })).toBe("not_revoked");
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
    await signedIn("http://127.0.0.1:1");
    expect(await signOut({ home, profile: "lab", server: "http://127.0.0.1:1" })).toBe(
      "not_revoked",
    );
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("a server that never answers: given up within the lock's bound, not_revoked, the file removed, the lock released", async () => {
    const s = await stand({ revokeHangs: true });
    await signedIn(s.origin);
    const started = Date.now();
    expect(
      await signOut({ home, profile: "lab", server: s.origin, testing: { lockedRequestMs: 300 } }),
    ).toBe("not_revoked");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(s.seen.filter((x) => x.path === "/oauth/revoke")).toHaveLength(1);
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
    expect(exists(`${profileCredentialsFile(home, "lab")}.lock`)).toBe(false);
  });

  it("a file for another server: no token sent anywhere, the file removed", async () => {
    const profile = await stand();
    const other = await stand();
    await signedIn(other.origin);
    expect(await signOut({ home, profile: "lab", server: profile.origin })).toBe("other_server");
    expect(profile.seen).toEqual([]);
    expect(other.seen).toEqual([]);
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("a file not of the form: nothing sent, removed", async () => {
    const s = await stand();
    mkdirSync(join(home, "credentials"), { mode: 0o700 });
    writeFileSync(profileCredentialsFile(home, "lab"), "{}\n", { mode: 0o600 });
    expect(await signOut({ home, profile: "lab", server: s.origin })).toBe("malformed");
    expect(s.seen).toEqual([]);
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
  });

  it("no file: none, nothing sent", async () => {
    const s = await stand();
    expect(await signOut({ home, profile: "lab", server: s.origin })).toBe("none");
    expect(s.seen).toEqual([]);
  });

  it("the lock held by another command: busy, the file kept", async () => {
    const s = await stand();
    await signedIn(s.origin);
    writeFileSync(`${profileCredentialsFile(home, "lab")}.lock`, "1 held\n", { mode: 0o600 });
    await expect(
      signOut({ home, profile: "lab", server: s.origin, testing: { lock: { waitMs: 100 } } }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(true);
    expect(s.seen).toEqual([]);
  });
});

describe("the profile login and logout act on", () => {
  it("--profile, else the one in use; local is taken as cloud", async () => {
    expect(await profileFor(home, undefined, undefined)).toEqual({
      profile: "cloud",
      server: CLOUD_SERVER,
      current: "local",
      register: false,
    });
    expect(await profileFor(home, "local", undefined)).toMatchObject({ profile: "cloud" });
  });

  it("--server registers a new name; it needs --profile, and not a built-in one", async () => {
    expect(await profileFor(home, "lab", "https://saveslot.example/")).toEqual({
      profile: "lab",
      server: "https://saveslot.example",
      current: "local",
      register: true,
    });
    await expect(profileFor(home, undefined, "https://saveslot.example")).rejects.toMatchObject({
      exit: 2,
      text: TEXTS.loginServerNeedsProfile,
    });
    for (const p of ["cloud", "local", "-x"]) {
      await expect(profileFor(home, p, "https://saveslot.example")).rejects.toMatchObject({
        exit: 2,
        text: TEXTS.loginProfileNotRegistrable,
      });
    }
    await expect(profileFor(home, "lab", "https://saveslot.example/path")).rejects.toMatchObject({
      exit: 2,
    });
  });

  it("a name not of the 06 §2 form, without --server: a usage error, not an unknown profile", async () => {
    await expect(profileFor(home, "Bad_Name", undefined)).rejects.toMatchObject({
      exit: 2,
      text: TEXTS.loginProfileInvalid,
    });
  });
});

describe("the commands", () => {
  async function cli(argv: string[], testing: SignInTesting = {}, signal?: StopSignal) {
    let out = "";
    let err = "";
    const code = await run(
      ["--home", home, ...argv],
      {},
      {
        out: (t: string) => {
          out += t;
        },
        err: (t: string) => {
          err += t;
        },
        stdoutIsTTY: false,
        stderrIsTTY: false,
        stdinIsTTY: false,
        watchSignals: (on) => {
          const timer = signal !== undefined ? setTimeout(() => on(signal), 20) : undefined;
          return () => clearTimeout(timer);
        },
        signInTesting: { sleep: async () => {}, ...testing },
      },
    );
    return { code, out, err };
  }

  it("login --server --profile signs in, then registers the profile; the one in use stays", async () => {
    const s = await stand();
    const r = await cli(["login", "--server", s.origin, "--profile", "lab", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      profile: "lab",
      server: s.origin,
      mode: "device",
      credentials: profileCredentialsFile(home, "lab"),
    });
    const p = await readProfiles(home);
    expect(p.servers.get("lab")).toBe(s.origin);
    expect(p.current).toBe("local");
    expect(r.out + r.err).not.toMatch(/sl[sr]_/);
  });

  it("login says where the tokens are, and how to put the profile in use", async () => {
    const s = await stand();
    const r = await cli(["login", "--server", s.origin, "--profile", "lab"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(profileCredentialsFile(home, "lab"));
    expect(r.out).toContain(`${TEXTS.loginUseHint} lab`);
  });

  it("a profile's name of the 06 §2 form is written as it is", async () => {
    const s = await stand();
    const r = await cli(["login", "--server", s.origin, "--profile", "my-lab"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(profile my-lab)");
    expect(r.out).toContain(`${TEXTS.loginUseHint} my-lab`);
  });

  it("a sign-in that fails registers no profile", async () => {
    const s = await stand({ polls: ["access_denied"] });
    const r = await cli(["login", "--server", s.origin, "--profile", "lab"]);
    expect(r.code).toBe(8);
    expect(r.err).toContain(TEXTS.loginDenied);
    expect((await readProfiles(home)).servers.has("lab")).toBe(false);
  });

  it.each([
    [["login", "--server", "https://saveslot.example"]],
    [["login", "--server", "https://saveslot.example", "--profile", "cloud"]],
    [["login", "extra"]],
    [["logout", "--server", "https://saveslot.example"]],
    [["login", "--profile", "Bad_Name"]],
    [["logout", "--profile", "Bad_Name"]],
  ])("%j: a usage error (2)", async (argv) => {
    expect((await cli(argv)).code).toBe(2);
  });

  it("logout revokes and removes; again: not signed in, exit 0", async () => {
    const s = await stand();
    expect((await cli(["login", "--server", s.origin, "--profile", "lab"])).code).toBe(0);
    const first = await cli(["logout", "--profile", "lab"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain(TEXTS.logoutRevoked);
    expect(s.seen.filter((x) => x.path === "/oauth/revoke")).toHaveLength(1);
    const again = await cli(["logout", "--profile", "lab"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain(TEXTS.logoutNone);
  });

  it("logout with the profile's lock held past its full wait: try again later (7), the file kept", async () => {
    const s = await stand();
    expect((await cli(["login", "--server", s.origin, "--profile", "lab"])).code).toBe(0);
    writeFileSync(`${profileCredentialsFile(home, "lab")}.lock`, "1 held\n", { mode: 0o600 });
    const r = await cli(["logout", "--profile", "lab"]);
    expect(r.code).toBe(7);
    expect(r.err).toContain(TEXTS.credential("busy"));
    expect(exists(profileCredentialsFile(home, "lab"))).toBe(true);
    expect(s.seen.filter((x) => x.path === "/oauth/revoke")).toEqual([]);
  }, 20_000);

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)(
    "stopped by %s while waiting: 128 plus its number, nothing written",
    async (sig, exit) => {
      const s = await stand({ polls: ["pending"] });
      const r = await cli(
        ["login", "--server", s.origin, "--profile", "lab"],
        { sleep: () => new Promise(() => {}) },
        sig,
      );
      expect(r.code).toBe(exit);
      expect(r.err).toContain(TEXTS.loginStopped);
      expect(exists(profileCredentialsFile(home, "lab"))).toBe(false);
      expect((await readProfiles(home)).servers.has("lab")).toBe(false);
    },
  );

  it("the stored file is the format of 06 §2, keys and all", async () => {
    const s = await stand();
    await cli(["login", "--server", s.origin, "--profile", "lab"]);
    const v = JSON.parse(await readFile(profileCredentialsFile(home, "lab"), "utf8"));
    expect(Object.keys(v).sort()).toEqual([
      "access_expires_at",
      "access_token",
      "format",
      "refresh_token",
      "server",
    ]);
    expect(v.format).toBe(1);
  });
});
