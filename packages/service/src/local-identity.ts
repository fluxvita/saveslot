// The local accounts as the identity provider of a self-hosted server (docs/zh-CN/spec/02-architecture.md
// §9, §12): its own login page under `/account/`, its own login state (a cookie, its hash in a row of
// `web_logins` whose ID is the login's session), and the accounts' state.
//
// - `GET /account/login` shows the form; `POST /account/login` checks it; `POST /account/logout` ends
//   the login. The pages may not be framed, and are English unless the browser's first language is
//   Chinese.
// - The form carries a token of its own, bound to a browser: an HMAC of the form cookie
//   (`SameSite=Strict`) the page set and the token's expiry, under a key made at random by this
//   process. It is good until it expires and only together with that cookie, so a token someone
//   fetched for themselves cannot sign another browser in to their account; it takes no memory, and
//   a restart expires the forms already out. A post, to sign in or out, whose `Origin` is not this
//   service's is refused too.
// - Login attempts are counted twice over 15 minutes: by source and name (5 refuse that name from
//   that source), by source alone (20 refuse the source). An attempt is counted before its password
//   is checked, so attempts sent at once cannot pass the limit together, and taken back when the
//   password is right. An IPv6 source counts by its /64, and its /48 is counted too (100 refuse
//   the /48), so that holding many /64s does not get past the limit; a name counts by its hash. In
//   this process: a restart forgets them. A count table full of live counts takes no new one: the
//   attempt is refused as over the limit, and no one's count is pushed out.
// - Too many password checks waiting already, or this one waiting too long for its turn: the attempt
//   is refused (503 with `Retry-After: 1`), uncounted.
// - Signed in: the login is written in a transaction that first checks, the account's row locked,
//   that the account still has the password hash just compared and is still active; a password
//   changed or the account disabled since the check answers as a wrong password, and leaves nothing.
// - A user session is issued from a web login only while the login lasts and the account is active:
//   the account's row locked, then the login's, as every path that changes them does.
// - A name without an account, a wrong password and a disabled account fail alike, with one message;
//   a name without an account is checked against a fixed hash so that the time taken is the same.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { UserId } from "./control-plane.ts";
import { Counts } from "./expiring.ts";
import {
  type CurrentUser,
  escapeHtml,
  type IdentityProvider,
  type IdentityRequest,
  type IdentityResponse,
  PAGE_HEADERS,
  pageLanguage,
  type SetCookie,
  safeReturnTo,
  sourceKey,
  UserSessionError,
  wideSourceKey,
  writeUserSession,
} from "./identity.ts";
import type { LocalAccounts } from "./local-accounts.ts";
import {
  lockAccountForSession,
  lockActiveAccount,
  PasswordChecksBusy,
  verifyLocalPassword,
} from "./local-passwords.ts";
import { type ControlDb, isInstant } from "./server-control-plane.ts";

/** The login state's cookie. */
export const LOGIN_COOKIE = "saveslot_login";
/** The cookie a login form's token is bound to: `__Host-` when the service is on HTTPS. */
export const FORM_COOKIE = "saveslot_login_form";
const WINDOW_MS = 15 * 60_000;
const PER_NAME = 5;
const PER_SOURCE = 20;
/** Attempts from one IPv6 /48 in a window, whatever its /64s (an initial value). */
export const PER_WIDE_SOURCE = 100;
const FORM_TOKEN_MS = 30 * 60_000;

const TEXT = {
  en: {
    title: "Sign in to saveslot",
    name: "Name",
    password: "Password",
    submit: "Sign in",
    failed: "The name or password is not right, or the account is disabled.",
    limited: "Too many attempts. Try again later.",
    busy: "Too many sign-ins at once. Try again in a moment.",
    expired: "The form expired. Please try again.",
  },
  zh: {
    title: "登录 saveslot",
    name: "用户名",
    password: "口令",
    submit: "登录",
    failed: "用户名或口令不对，或者账户已停用。",
    limited: "尝试次数太多，请稍后再试。",
    busy: "同时登录的人太多，请稍后再试。",
    expired: "表单已过期，请重试。",
  },
} as const;

type Notice = "failed" | "limited" | "busy" | "expired";

const LOGIN_PATH = "/account/login";
const LOGOUT_PATH = "/account/logout";

export class LocalIdentity implements IdentityProvider {
  readonly paths: ReadonlySet<string> = new Set([LOGIN_PATH, LOGOUT_PATH]);
  readonly #db: ControlDb;
  readonly #now: () => number;
  readonly #loginMs: number;
  readonly #origin: string;
  readonly #secure: boolean;
  readonly #formCookie: string;
  /** What form tokens are made with: this process's alone. */
  readonly #formKey = randomBytes(32);
  readonly #byName: Counts;
  readonly #bySource: Counts;
  readonly #byWide: Counts;

  constructor(o: {
    readonly accounts: LocalAccounts;
    /** How long a login lasts. */
    readonly loginMs: number;
    /**
     * The service's public origin (`https://host[:port]`, `http://` on loopback only), taken in its
     * normal form (no trailing `/`, no default port): a post from another is refused; on HTTPS,
     * cookies are `Secure` and the form cookie `__Host-`.
     */
    readonly origin: string;
    readonly now?: () => number;
    /** Tests only: how many entries each count table holds at most. */
    readonly countCapForTests?: number;
  }) {
    this.#db = o.accounts.db;
    this.#byName = new Counts(WINDOW_MS, o.countCapForTests);
    this.#bySource = new Counts(WINDOW_MS, o.countCapForTests);
    this.#byWide = new Counts(WINDOW_MS, o.countCapForTests);
    this.#loginMs = o.loginMs;
    this.#origin = new URL(o.origin).origin;
    this.#secure = this.#origin.startsWith("https://");
    this.#formCookie = this.#secure ? `__Host-${FORM_COOKIE}` : FORM_COOKIE;
    this.#now = o.now ?? Date.now;
  }

  async currentUser(req: IdentityRequest): Promise<CurrentUser | undefined> {
    const cookie = req.cookies.get(LOGIN_COOKIE);
    if (cookie === undefined) return undefined;
    const r = await this.#db.read((tx) =>
      tx.query<{ id: string; user_id: string; name: string; expires_at: string }>(
        `SELECT l.id, l.user_id, a.name, l.expires_at FROM web_logins l JOIN accounts a ON a.id = l.user_id
           WHERE l.cookie_hash = $1 AND l.expires_at > $2 AND a.state = 'active'`,
        [hashOf(cookie), new Date(this.#now()).toISOString()],
      ),
    );
    const row = r.rows[0];
    return row === undefined
      ? undefined
      : { user: row.user_id as UserId, session: row.id, name: row.name, expiresAt: row.expires_at };
  }

  async beginLogin(_req: IdentityRequest, returnTo: string): Promise<IdentityResponse> {
    const to = safeReturnTo(returnTo);
    if (to === undefined) return { kind: "page", status: 400, html: "", headers: PAGE_HEADERS };
    return { kind: "redirect", location: `/account/login?return_to=${encodeURIComponent(to)}` };
  }

  async handle(req: IdentityRequest): Promise<IdentityResponse | undefined> {
    if (req.path === LOGIN_PATH && req.method === "GET") {
      const to = safeReturnTo(req.query.get("return_to"));
      if (to === undefined) return this.#bad();
      return this.#form(req, to, undefined, 200);
    }
    if (req.path === LOGIN_PATH && req.method === "POST") return this.#login(req);
    if (req.path === LOGOUT_PATH && req.method === "POST") return this.#logout(req);
    return undefined;
  }

  /**
   * A user session from a web login: the account's row locked, then the login's; none for an account
   * not active, or from a login signed out, expired, or ended by a password change. The local
   * accounts take no identity assertions.
   */
  async issueUserSession(
    user: UserId,
    o: Parameters<IdentityProvider["issueUserSession"]>[1],
  ): Promise<string> {
    const from = o.from;
    if ("assertion" in from) throw new Error("the local accounts take no identity assertions");
    if (!isInstant(o.now)) throw new Error("the time is an instant as toISOString writes it");
    if ("refresh" in from && !isInstant(from.refresh.grantedAt)) {
      throw new Error("a grant's time is an instant as toISOString writes it");
    }
    return this.#db.write(async (tx) => {
      const ended = new UserSessionError("login_ended", "the login has ended");
      // A refresh has no login to lock: a password change since its grant ends it.
      const account = await lockAccountForSession(
        tx,
        user,
        "refresh" in from ? from.refresh.grantedAt : undefined,
      );
      if (account === "inactive") {
        throw new UserSessionError("account_inactive", "the account is not active");
      }
      if (account !== "active") throw ended;
      if ("login" in from) {
        const l = await tx.query(
          "SELECT 1 FROM web_logins WHERE id = $1 AND user_id = $2 AND expires_at > $3 FOR SHARE",
          [from.login, user, o.now],
        );
        if (l.rows.length === 0) throw ended;
      }
      return writeUserSession(tx, user, {
        expiresAt: o.expiresAt,
        ...(o.grant === undefined ? {} : { grant: o.grant }),
      });
    });
  }

  async userState(user: UserId): Promise<"active" | "disabled" | "unknown"> {
    const r = await this.#db.read((tx) =>
      tx.query<{ state: "active" | "disabled" }>("SELECT state FROM accounts WHERE id = $1", [
        user,
      ]),
    );
    return r.rows[0]?.state ?? "unknown";
  }

  async #login(req: IdentityRequest): Promise<IdentityResponse> {
    const form = req.form ?? new Map<string, string>();
    const to = safeReturnTo(form.get("return_to"));
    if (to === undefined) return this.#bad();
    if (this.#foreign(req)) return this.#refused(403);
    const now = this.#now();
    if (!this.#tokenGood(form.get("form_token"), req.cookies.get(this.#formCookie), now)) {
      return this.#form(req, to, "expired", 400);
    }
    const name = form.get("name") ?? "";
    const password = form.get("password") ?? "";
    const source = sourceKey(req.remote);
    const nameKey = `${source}\u0000${createHash("sha256").update(name).digest("hex")}`;
    const wide = wideSourceKey(req.remote);
    // The /48 first: it is checked, and counted, before the narrower ones.
    const counts: [Counts, string, number][] = [
      ...(wide === undefined
        ? []
        : [[this.#byWide, wide, PER_WIDE_SOURCE] as [Counts, string, number]]),
      [this.#byName, nameKey, PER_NAME],
      [this.#bySource, source, PER_SOURCE],
    ];
    if (counts.some(([c, key, limit]) => c.get(key, now) >= limit)) {
      return this.#form(req, to, "limited", 429);
    }
    // Counted before the password is checked: attempts sent at once see each other's.
    const added: [Counts, string][] = [];
    for (const [c, key] of counts) {
      if (!c.add(key, now)) {
        for (const [d, k] of added) d.takeBack(k, now);
        return this.#form(req, to, "limited", 429);
      }
      added.push([c, key]);
    }
    const takeBack = () => {
      for (const [c, key] of added) c.takeBack(key, now);
    };
    let account: Awaited<ReturnType<typeof verifyLocalPassword>>;
    try {
      account = await verifyLocalPassword(this.#db, name, password, { refuseWhenBusy: true });
    } catch (e) {
      if (!(e instanceof PasswordChecksBusy)) throw e;
      takeBack();
      return this.#form(req, to, "busy", 503, [["retry-after", "1"]]);
    }
    if (account === undefined) return this.#form(req, to, "failed", 401);
    const cookie = randomBytes(32).toString("base64url");
    // Only if the account still has the hash just compared and is active, its row locked: a
    // password change or a disable since then answers as a wrong password, and writes nothing.
    const written = await this.#db.write(async (tx) => {
      if (!(await lockActiveAccount(tx, account.user, account.passwordHash))) return false;
      await tx.query(
        "INSERT INTO web_logins (id, cookie_hash, user_id, expires_at) VALUES ($1, $2, $3, $4)",
        [
          randomBytes(16).toString("base64url"),
          hashOf(cookie),
          account.user,
          new Date(now + this.#loginMs).toISOString(),
        ],
      );
      return true;
    });
    if (!written) return this.#form(req, to, "failed", 401);
    // Signed in: this attempt is no failure.
    takeBack();
    return {
      kind: "redirect",
      location: to,
      cookies: [this.#cookie(cookie, Math.floor(this.#loginMs / 1000))],
    };
  }

  async #logout(req: IdentityRequest): Promise<IdentityResponse> {
    if (this.#foreign(req)) return this.#refused(403);
    const cookie = req.cookies.get(LOGIN_COOKIE);
    if (cookie !== undefined) {
      await this.#db.write((tx) =>
        tx.query("DELETE FROM web_logins WHERE cookie_hash = $1", [hashOf(cookie)]),
      );
    }
    return {
      kind: "redirect",
      location: "/account/login?return_to=%2Foauth%2F",
      cookies: [this.#cookie("", 0)],
    };
  }

  /** Whether the request names an `Origin` other than this service's. */
  #foreign(req: IdentityRequest): boolean {
    const origin = req.headers.get("origin");
    return origin !== undefined && origin !== this.#origin;
  }

  #refused(status: number): IdentityResponse {
    return { kind: "page", status, html: "", headers: PAGE_HEADERS };
  }

  /** A form token: its expiry, and an HMAC of the form cookie with that expiry. */
  #token(binding: string, until: number): string {
    const mac = createHmac("sha256", this.#formKey).update(`${binding}.${until}`).digest();
    return `${until}.${mac.toString("base64url")}`;
  }

  /** Whether `token` is one this process made for the form cookie `binding`, and not expired. */
  #tokenGood(token: string | undefined, binding: string | undefined, now: number): boolean {
    if (token === undefined || binding === undefined) return false;
    const m = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (m === null) return false;
    const until = Number(m[1]);
    if (until <= now || until > now + FORM_TOKEN_MS) return false;
    const want = Buffer.from(this.#token(binding, until));
    const got = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  #cookie(value: string, maxAgeSeconds: number): SetCookie {
    return { name: LOGIN_COOKIE, value, maxAgeSeconds, path: "/", secure: this.#secure };
  }

  #bad(): IdentityResponse {
    return this.#refused(400);
  }

  #form(
    req: IdentityRequest,
    to: string,
    notice: Notice | undefined,
    status: number,
    headers: readonly (readonly [string, string])[] = [],
  ): IdentityResponse {
    const lang = pageLanguage(req.headers.get("accept-language"));
    const t = TEXT[lang];
    const binding = req.cookies.get(this.#formCookie) ?? randomBytes(24).toString("base64url");
    const token = this.#token(binding, this.#now() + FORM_TOKEN_MS);
    const formCookie: SetCookie = {
      name: this.#formCookie,
      value: binding,
      maxAgeSeconds: FORM_TOKEN_MS / 1000,
      path: "/",
      secure: this.#secure,
      sameSite: "Strict",
    };
    const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(t.title)}</title></head>
<body><main><h1>${escapeHtml(t.title)}</h1>${
      notice === undefined ? "" : `<p role="alert">${escapeHtml(t[notice])}</p>`
    }
<form method="post" action="/account/login">
<input type="hidden" name="form_token" value="${escapeHtml(token)}">
<input type="hidden" name="return_to" value="${escapeHtml(to)}">
<label>${escapeHtml(t.name)} <input name="name" autocomplete="username" required></label>
<label>${escapeHtml(t.password)} <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">${escapeHtml(t.submit)}</button>
</form></main></body></html>
`;
    return {
      kind: "page",
      status,
      html,
      headers: [...PAGE_HEADERS, ...headers],
      cookies: [formCookie],
    };
  }
}

const hashOf = (cookie: string): string => createHash("sha256").update(cookie).digest("hex");
