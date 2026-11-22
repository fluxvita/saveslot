// Signing in to a server profile (06-cli §2, §4.2): `saveslot login`, and `signIn`, the part
// `setup --profile` uses as well. The server side of these endpoints is 05-surfaces §15.
//
// - The server's authorization server metadata is read first; its `issuer` must be the server's
//   address to the character, or no request is made with anything of the sign-in's.
// - Browser: a loopback listener on 127.0.0.1 at `/callback` that takes one callback of this
//   sign-in's `state` (another is answered 400 and waited past), PKCE S256, `iss` checked (RFC 9207). The browser is opened only when someone is at a
//   terminal; the address is printed always. Device (RFC 8628): the user code and the page are
//   printed, the token endpoint polled at the interval given. The pages printed are the server's
//   words: written inside the untrusted boundary (06 §6.4).
// - Every timer a sign-in sets is cleared on every way out: the process ends when the command does.
// - A stop signal that comes while the tokens are fetched still ends it with nothing written.
// - Every request carries `client_id=saveslot-cli` and `resource` = the server.
// - The pair is written under the profile's lock (`withProfileLock`), atomically, 0600. This
//   writes no `profiles.json`: `login --server` registers the profile after the sign-in. The
//   sign-in it replaces has its refresh token revoked, best effort, at the same server only.
// - No token in a message, on stdout or on the page the browser is shown.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BUILT_IN_PROFILES,
  CLI_CLIENT_ID,
  ClientUsageError,
  ContractCallError,
  CredentialError,
  OAuthError,
  oauthPost,
  PROFILE_NAME,
  type ProfileCredentials,
  profileCredentialsFile,
  profileServer,
  readProfileCredentials,
  readProfiles,
  request,
  serverOrigin,
  TransportError,
  withProfileLock,
  writeProfileCredentials,
} from "@fluxvita/saveslot-client";
import {
  type Boundary,
  type Line,
  t as line,
  render,
  untrusted,
  userCode,
  words,
} from "./render/text.ts";
import { type Static, TEXTS } from "./texts.ts";

/** What `signIn` writes to: progress and the address to open, on stderr. */
export interface SignInIO {
  readonly err: (text: string) => void;
  readonly stdinIsTTY?: boolean;
  readonly stderrIsTTY: boolean;
  /** How the server's words are written on stderr (06 §6.4); by `stderrIsTTY` otherwise. */
  readonly boundary?: Boundary;
}

export type SignInMode = "browser" | "device";

/** `signIn`'s stand-ins for tests; none is for a real caller. */
export interface SignInTesting {
  /** Shows the user a page (the platform's opener otherwise). */
  readonly openBrowser?: (url: string) => void;
  readonly now?: () => number;
  /** The wait between polls; `stop` is the sign-in's. */
  readonly sleep?: (ms: number, stop: AbortSignal | undefined) => Promise<void>;
  /** How long the browser's callback is waited for (CALLBACK_WAIT_MS otherwise). */
  readonly callbackWaitMs?: number;
  /** The profile lock's wait and staleness (06 §2's otherwise). */
  readonly lock?: { readonly waitMs?: number; readonly staleMs?: number };
}

export type SignInResult =
  | { readonly ok: true; readonly mode: SignInMode }
  | { readonly ok: false; readonly exit: number; readonly message: Static };

/** How long the browser's callback is waited for. */
export const CALLBACK_WAIT_MS = 5 * 60_000;
/** What a `slow_down` adds to the interval between polls (RFC 8628 §3.5). */
const SLOW_DOWN_S = 5;
/**
 * The device code's bounds, whatever the server says (RFC 8628 §3.2 sets none). An interval over a
 * minute would leave the person waiting after they approve; a code is not waited on past an hour
 * (codes are minutes long: ours, 10). Both keep every wait far below what a timer can hold (Node
 * makes a delay over 2^31 - 1 ms one of 1 ms).
 */
const MAX_INTERVAL_S = 60;
const MAX_CODE_S = 60 * 60;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const USER_CODE = /^[A-Z]{4}-[A-Z]{4}$/;

/** Ends a sign-in with an exit code and what to say. */
class Ended extends Error {
  readonly exit: number;
  readonly text: Static;
  constructor(exit: number, text: Static) {
    super(text);
    this.exit = exit;
    this.text = text;
  }
}

const base64url = (b: Buffer) => b.toString("base64url");

/** An address on the server, as `URL#href` writes it (no control character survives that). */
function onServer(v: unknown, server: string): string {
  if (typeof v !== "string") throw new Ended(1, TEXTS.loginBadAnswer);
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Ended(1, TEXTS.loginBadAnswer);
  }
  if (u.origin !== server || u.username !== "" || u.password !== "") {
    throw new Ended(1, TEXTS.loginBadAnswer);
  }
  return u.href;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * `p`'s outcome; or undefined once `ms` has passed (no limit when undefined); or Ended 130 once
 * `stop` fires: whichever comes first. The timer is cleared and the listener removed on every way
 * out, so nothing is left pending to keep the process up.
 */
function settle<T>(
  p: Promise<T>,
  ms: number | undefined,
  stop: AbortSignal | undefined,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (stop?.aborted) {
      p.catch(() => {});
      reject(new Ended(130, TEXTS.loginStopped));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      stop?.removeEventListener("abort", stopped);
    };
    const stopped = () => {
      done();
      reject(new Ended(130, TEXTS.loginStopped));
    };
    if (ms !== undefined) {
      timer = setTimeout(() => {
        done();
        resolve(undefined);
      }, ms);
    }
    stop?.addEventListener("abort", stopped, { once: true });
    p.then(
      (v) => {
        done();
        resolve(v);
      },
      (e: unknown) => {
        done();
        reject(e);
      },
    );
  });
}

/** Waits `ms`, or until `stop`; stopped: Ended 130. */
const pause = (ms: number, stop: AbortSignal | undefined): Promise<void> =>
  settle(new Promise<never>(() => {}), ms, stop).then(() => {});

/** The default way to show the user a page: the platform's opener, detached; failures ignored. */
function openWithPlatform(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The address is printed: opening it by hand works as well.
  }
}

/** Statuses that say "busy, later" whatever the body: the server's or a proxy's in front of it. */
const BUSY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * A transport or an OAuth error of a request the sign-in made, as an end. Busy or limited (a
 * status above, the contract's `unavailable` or `rate_limited`, OAuth's `temporarily_unavailable`)
 * is 7 with not reachable: try again later (06 §6.2).
 */
function endOf(e: unknown): Ended {
  if (e instanceof Ended) return e;
  if (e instanceof TransportError) {
    if (e.code !== "bad_answer") return new Ended(7, TEXTS.loginUnreachable);
    return e.status !== undefined && BUSY_STATUSES.has(e.status)
      ? new Ended(7, TEXTS.loginBusy)
      : new Ended(1, TEXTS.loginBadAnswer);
  }
  if (e instanceof ContractCallError && (e.code === "unavailable" || e.code === "rate_limited")) {
    return new Ended(7, TEXTS.loginBusy);
  }
  if (e instanceof OAuthError) {
    if (e.code === "temporarily_unavailable") return new Ended(7, TEXTS.loginBusy);
    if (e.code === "access_denied") return new Ended(6, TEXTS.loginDenied);
    if (e.code === "expired_token") return new Ended(6, TEXTS.loginExpired);
    return new Ended(6, TEXTS.loginRefused);
  }
  if (e instanceof CredentialError) return new Ended(6, TEXTS.credential(e.code));
  // Anything else from a request: an answer that is not one of these endpoints'.
  return new Ended(1, TEXTS.loginBadAnswer);
}

interface Deps {
  readonly server: string;
  readonly now: () => number;
  readonly stop: AbortSignal | undefined;
}

/** The token endpoint's answer, as the credentials to write (`expires_in` from `received`). */
function pairOf(a: Record<string, unknown> | undefined, server: string, received: number) {
  const x = a ?? {};
  if (
    typeof x["access_token"] !== "string" ||
    typeof x["refresh_token"] !== "string" ||
    !positive(x["expires_in"])
  ) {
    throw new Ended(1, TEXTS.loginBadAnswer);
  }
  return {
    server,
    access_token: x["access_token"],
    access_expires_at: new Date(received + x["expires_in"] * 1000).toISOString(),
    refresh_token: x["refresh_token"],
  };
}

async function token(d: Deps, form: [string, string][]) {
  const answer = await oauthPost({
    server: d.server,
    path: "/oauth/token",
    form: new Map([...form, ["client_id", CLI_CLIENT_ID], ["resource", d.server]]),
  });
  return pairOf(answer, d.server, d.now());
}

/** The callback the browser brings back: its query, once. */
interface Callback {
  readonly redirectUri: string;
  readonly query: Promise<URLSearchParams>;
  readonly close: () => Promise<void>;
}

/**
 * Listens on 127.0.0.1, port chosen by the system, for one GET of `/callback` that is `ours` (of
 * this sign-in's `state`). That one is answered with a page saying the sign-in is done or not
 * (decided by `outcome`); one not ours gets 400 and the wait goes on, so another process on the
 * machine cannot end a sign-in by calling first; any after ours gets 400, any other path 404.
 * Closed by `close`, whatever came.
 */
async function listen(
  ours: (q: URLSearchParams) => boolean,
  outcome: (q: URLSearchParams) => boolean,
): Promise<Callback> {
  let taken = false;
  let deliver: (q: URLSearchParams) => void = () => {};
  const query = new Promise<URLSearchParams>((r) => {
    deliver = r;
  });
  const page = (res: ServerResponse, status: number, text: Static) =>
    res
      .writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      })
      .end(`${text}\n`);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      page(res, 404, TEXTS.loginPageNotHere);
      return;
    }
    if (taken) {
      page(res, 400, TEXTS.loginPageUsed);
      return;
    }
    if (!ours(url.searchParams)) {
      page(res, 400, TEXTS.loginPageNotThis);
      return;
    }
    taken = true;
    page(res, 200, outcome(url.searchParams) ? TEXTS.loginPageDone : TEXTS.loginPageFailed);
    deliver(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    query,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function browser(
  d: Deps,
  o: {
    readonly io: SignInIO;
    readonly open: ((url: string) => void) | undefined;
    readonly waitMs: number;
  },
) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  const ours = (q: URLSearchParams) => q.getAll("state").length === 1 && q.get("state") === state;
  const fits = (q: URLSearchParams) =>
    q.getAll("iss").length === 1 &&
    q.get("iss") === d.server &&
    q.getAll("code").length === 1 &&
    !q.has("error");
  const cb = await listen(ours, fits);
  try {
    const url = new URL(`${d.server}/oauth/authorize`);
    for (const [k, v] of [
      ["response_type", "code"],
      ["client_id", CLI_CLIENT_ID],
      ["redirect_uri", cb.redirectUri],
      ["code_challenge", challenge],
      ["code_challenge_method", "S256"],
      ["state", state],
      ["resource", d.server],
    ] as const) {
      url.searchParams.set(k, v);
    }
    o.io.err(`${TEXTS.loginOpen}\n  ${url.href}\n`);
    o.open?.(url.href);
    // Only a callback of this sign-in's `state` comes through (`listen`).
    const q = await settle(cb.query, o.waitMs, d.stop);
    if (q === undefined) throw new Ended(6, TEXTS.loginTimedOut);
    if (q.getAll("iss").length !== 1 || q.get("iss") !== d.server) {
      throw new Ended(6, TEXTS.loginIssuerMismatch);
    }
    if (q.has("error")) {
      throw new Ended(
        6,
        q.get("error") === "access_denied" ? TEXTS.loginDenied : TEXTS.loginRefused,
      );
    }
    const code = q.getAll("code");
    if (code.length !== 1 || code[0] === "") throw new Ended(6, TEXTS.loginRefused);
    return await token(d, [
      ["grant_type", "authorization_code"],
      ["code", code[0] as string],
      ["redirect_uri", cb.redirectUri],
      ["code_verifier", verifier],
    ]);
  } finally {
    await cb.close();
  }
}

async function device(
  d: Deps,
  o: {
    readonly io: SignInIO;
    readonly sleep: (ms: number, stop: AbortSignal | undefined) => Promise<void>;
  },
) {
  const a =
    (await oauthPost({
      server: d.server,
      path: "/oauth/device",
      form: new Map([
        ["client_id", CLI_CLIENT_ID],
        ["resource", d.server],
      ]),
    })) ?? {};
  const started = d.now();
  const deviceCode = a["device_code"];
  const code = a["user_code"];
  if (
    typeof deviceCode !== "string" ||
    deviceCode === "" ||
    typeof code !== "string" ||
    !USER_CODE.test(code) ||
    !positive(a["expires_in"]) ||
    (a["interval"] !== undefined && !positive(a["interval"]))
  ) {
    throw new Ended(1, TEXTS.loginBadAnswer);
  }
  const page = onServer(a["verification_uri"], d.server);
  const complete =
    a["verification_uri_complete"] !== undefined
      ? onServer(a["verification_uri_complete"], d.server)
      : undefined;
  const lines: Line[] = [
    [words(TEXTS.loginDeviceOpen)],
    line`  ${untrusted(page)}`,
    line`${words(TEXTS.loginDeviceCode)} ${userCode(code)}`,
  ];
  if (complete !== undefined) {
    lines.push([words(TEXTS.loginDeviceComplete)], line`  ${untrusted(complete)}`);
  }
  const boundary: Boundary =
    o.io.boundary ?? (o.io.stderrIsTTY ? { kind: "terminal", color: false } : { kind: "tagged" });
  o.io.err(`${render(lines, boundary)}\n`);
  const deadline = started + Math.min(a["expires_in"], MAX_CODE_S) * 1000;
  let interval = Math.min((a["interval"] as number | undefined) ?? 5, MAX_INTERVAL_S);
  for (;;) {
    await settle(o.sleep(interval * 1000, d.stop), undefined, d.stop);
    if (d.stop?.aborted) throw new Ended(130, TEXTS.loginStopped);
    if (d.now() >= deadline) throw new Ended(6, TEXTS.loginExpired);
    try {
      return await token(d, [
        ["grant_type", DEVICE_GRANT],
        ["device_code", deviceCode],
      ]);
    } catch (e) {
      if (e instanceof OAuthError && e.code === "authorization_pending") continue;
      if (e instanceof OAuthError && e.code === "slow_down") {
        interval = Math.min(interval + SLOW_DOWN_S, MAX_INTERVAL_S);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Signs profile `profile` in at `server` (an origin, as `serverOrigin` writes it) and writes its
 * credentials file. `mode`: browser by default only when stdin and stderr are terminals, else
 * device; a browser is opened only then, an explicit `browser` otherwise prints the address and
 * waits. The message of an end holds no token; the caller writes it.
 * - The issuer not the server, the sign-in refused, denied, expired or timed out: exit 6.
 * - The server not reachable, busy or limiting: 7; an answer not of these endpoints: 1.
 * - `stop`: 130, the listener closed, nothing written; also when it comes while the tokens are
 *   fetched (06 §6.2).
 */
export async function signIn(o: {
  readonly home: string;
  readonly profile: string;
  readonly server: string;
  readonly io: SignInIO;
  readonly stop?: AbortSignal;
  readonly mode?: SignInMode;
  /** Tests only: what stands in for the platform, the clock and the waits. */
  readonly testing?: SignInTesting;
}): Promise<SignInResult> {
  const interactive = o.io.stdinIsTTY === true && o.io.stderrIsTTY;
  const mode = o.mode ?? (interactive ? "browser" : "device");
  const t = o.testing ?? {};
  try {
    if (!PROFILE_NAME.test(o.profile) || o.profile === "local") {
      throw new Ended(2, TEXTS.loginProfileInvalid);
    }
    let server: string;
    try {
      server = serverOrigin(o.server).origin;
    } catch {
      throw new Ended(2, TEXTS.loginServerInvalid);
    }
    if (server !== o.server) throw new Ended(2, TEXTS.loginServerInvalid);
    const d: Deps = { server, now: t.now ?? Date.now, stop: o.stop };
    let metadata: unknown;
    try {
      metadata = await request({
        server,
        method: "GET",
        path: "/.well-known/oauth-authorization-server",
      });
    } catch (e) {
      throw endOf(e);
    }
    const issuer =
      metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)["issuer"]
        : undefined;
    if (issuer !== server) throw new Ended(6, TEXTS.loginIssuerMismatch);
    if (o.stop?.aborted) throw new Ended(130, TEXTS.loginStopped);
    let pair: ReturnType<typeof pairOf>;
    try {
      pair =
        mode === "browser"
          ? await browser(d, {
              io: o.io,
              open: interactive ? (t.openBrowser ?? openWithPlatform) : undefined,
              waitMs: t.callbackWaitMs ?? CALLBACK_WAIT_MS,
            })
          : await device(d, { io: o.io, sleep: t.sleep ?? pause });
    } catch (e) {
      throw endOf(e);
    }
    // A stop that came while the last request was out: the tokens are not written.
    if (o.stop?.aborted) throw new Ended(130, TEXTS.loginStopped);
    let old: ProfileCredentials | undefined;
    try {
      old = await withProfileLock(
        o.home,
        o.profile,
        async () => {
          // The sign-in this one replaces; a file not readable as one has nothing to revoke.
          // Nothing is sent holding the lock: the revocation below runs after it is released.
          const before = await readProfileCredentials(o.home, o.profile).catch(() => undefined);
          await writeProfileCredentials(o.home, o.profile, pair);
          return before;
        },
        t.lock,
      );
    } catch (e) {
      // The profile's name is checked above, so a usage error here is the write refusing a pair
      // not of the tokens' form: the server's answer. Anything else keeps its own cause.
      if (e instanceof ClientUsageError) throw new Ended(1, TEXTS.loginBadAnswer);
      if (e instanceof CredentialError) throw new Ended(6, TEXTS.credential(e.code));
      throw new Ended(1, TEXTS.loginUnsaved);
    }
    // The replaced sign-in's refresh token would stay good on the server with no one holding it:
    // revoked, best effort, and only at the server it was issued by (06 §2, as logout does).
    if (old !== undefined && old.server === server && old.refresh_token !== pair.refresh_token) {
      try {
        await oauthPost({
          server,
          path: "/oauth/revoke",
          form: new Map([
            ["token", old.refresh_token],
            ["token_type_hint", "refresh_token"],
            ["client_id", CLI_CLIENT_ID],
          ]),
        });
      } catch {
        o.io.err(`${TEXTS.loginOldNotRevoked}\n`);
      }
    }
    return { ok: true, mode };
  } catch (e) {
    if (e instanceof Ended) return { ok: false, exit: e.exit, message: e.text };
    throw e;
  }
}

/**
 * The profile `login` and `logout` act on, and its server: `--profile`, else the one in use, with
 * `local` (no sign-in) taken as `cloud`. `--server` registers a profile: it needs `--profile`,
 * and a name that can be registered.
 */
export async function profileFor(
  home: string,
  given: string | undefined,
  serverGiven: string | undefined,
): Promise<{ profile: string; server: string; current: string; register: boolean }> {
  const current = (await readProfiles(home)).current;
  if (serverGiven !== undefined) {
    if (given === undefined) throw new Ended(2, TEXTS.loginServerNeedsProfile);
    if (!PROFILE_NAME.test(given) || (BUILT_IN_PROFILES as readonly string[]).includes(given)) {
      throw new Ended(2, TEXTS.loginProfileNotRegistrable);
    }
    let server: string;
    try {
      server = serverOrigin(serverGiven).origin;
    } catch {
      throw new Ended(2, TEXTS.loginServerInvalid);
    }
    return { profile: given, server, current, register: true };
  }
  if (given !== undefined && !PROFILE_NAME.test(given)) {
    throw new Ended(2, TEXTS.loginProfileInvalid);
  }
  const chosen = given ?? current;
  const profile = chosen === "local" ? "cloud" : chosen;
  const server = await profileServer(home, profile);
  return { profile, server: server as string, current, register: false };
}

export { Ended as LoginEnded, profileCredentialsFile };
