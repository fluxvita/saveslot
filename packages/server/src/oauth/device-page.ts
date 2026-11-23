// The device code's verification page (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»; RFC 8628
// §3.3): `GET /oauth/device/verify` shows the user who is signed in a form for the code their
// terminal shows, `POST` takes it with the answer. It says plainly that it signs the saveslot CLI
// in, and only an explicit approve does.
//
// Signing in is the identity provider's, as on the authorization page (consent.ts), whose page
// helpers, headers and one-time form tokens it shares: the form token is bound to the provider's
// sign-in and to this page, so an authorization page's token is no good here, nor this one's there. A user code is short, so wrong ones are counted, per sign-in and per source address, in
// this process: 5 per sign-in or 20 per source within 15 minutes, then refused until the window
// ends. A try takes its place in the count before anything is awaited, so tries sent at once cannot
// pass the limit; a right code gives its place back.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  answerDeviceCode,
  CODE_SECONDS,
  DEVICE_VERIFY_PATH,
  escapeHtml,
  type IdentityRequest,
  readUserCode,
  safeReturnTo,
  tokenHash,
} from "@fluxvita/saveslot-service";
import {
  type ConsentContext,
  cookiesOf,
  errorPage,
  FORM_SECONDS,
  fieldsOf,
  headersOf,
  identityResponse,
  page,
  readForm,
  sendPage,
} from "./consent.ts";
import { langOf, type OAuthTexts, oauthTexts } from "./texts.ts";

/** How many wrong codes, within what window, and how many keys each count keeps. */
export interface TryLimits {
  readonly perSignIn: number;
  readonly perSource: number;
  readonly windowMs: number;
  /** Entries each count keeps at most. */
  readonly cap: number;
}

export const DEVICE_TRY_LIMITS: TryLimits = {
  perSignIn: 5,
  perSource: 20,
  windowMs: 15 * 60_000,
  cap: 10_000,
};

/** One count of tries by key, each counted until its window ends; at most `cap` keys. */
class TryCount {
  readonly #m = new Map<string, { n: number; until: number }>();
  readonly #limit: number;
  readonly #cap: number;

  constructor(limit: number, cap: number) {
    this.#limit = limit;
    this.#cap = cap;
  }

  /**
   * Whether `key` may try once more at `now`. A new key when the count is full, after the expired
   * entries went, may not: no live entry is dropped to make room.
   */
  allows(key: string, now: number): boolean {
    const e = this.#m.get(key);
    if (e !== undefined && e.until > now) return e.n < this.#limit;
    if (e !== undefined) this.#m.delete(key);
    if (this.#m.size < this.#cap) return true;
    for (const [k, v] of this.#m) if (v.until <= now) this.#m.delete(k);
    return this.#m.size < this.#cap;
  }

  /** Counts one try of `key` (which `allows`); the window starts with its first try. */
  add(key: string, now: number, windowMs: number): void {
    const e = this.#m.get(key);
    if (e !== undefined && e.until > now) e.n++;
    else this.#m.set(key, { n: 1, until: now + windowMs });
  }

  /** Gives a try back: a right code is not counted. */
  remove(key: string): void {
    const e = this.#m.get(key);
    if (e === undefined) return;
    if (e.n <= 1) this.#m.delete(key);
    else e.n--;
  }
}

/** Wrong user codes, per sign-in and per source. Each server process has one. */
export class DeviceTries {
  readonly #limits: TryLimits;
  readonly #signIns: TryCount;
  readonly #sources: TryCount;

  constructor(limits: TryLimits = DEVICE_TRY_LIMITS) {
    this.#limits = limits;
    this.#signIns = new TryCount(limits.perSignIn, limits.cap);
    this.#sources = new TryCount(limits.perSource, limits.cap);
  }

  /**
   * Takes a try for this sign-in and source at `now`, at once (nothing awaited): false when either
   * is at its limit, and then nothing is counted. A try taken is given back by `giveBack`.
   */
  take(signIn: string, source: string, now: number): boolean {
    if (!this.#signIns.allows(signIn, now) || !this.#sources.allows(source, now)) return false;
    this.#signIns.add(signIn, now, this.#limits.windowMs);
    this.#sources.add(source, now, this.#limits.windowMs);
    return true;
  }

  giveBack(signIn: string, source: string): void {
    this.#signIns.remove(signIn);
    this.#sources.remove(source);
  }
}

/** What the page's form token is bound to: the sign-in, and this page. */
const formBinding = (session: string) => `${session} ${DEVICE_VERIFY_PATH}`;

/** The process's counts, when the host gives none. */
const PROCESS_TRIES = new DeviceTries();

export interface DevicePageContext extends ConsentContext {
  /** The counts of wrong codes; the process's own when not given. */
  readonly deviceTries?: DeviceTries;
}

function verifyPage(
  t: OAuthTexts,
  o: {
    readonly userName: string;
    readonly form: string;
    readonly code: string;
    readonly problem?: string;
  },
): string {
  const parts = [
    `<h1>${escapeHtml(t.device.title)}</h1>`,
    `<p>${escapeHtml(t.signedInAs(o.userName))}</p>`,
    `<p><strong>${escapeHtml(t.device.explain)}</strong></p>`,
  ];
  if (o.problem !== undefined) parts.push(`<p class="error">${escapeHtml(o.problem)}</p>`);
  parts.push(
    `<form method="post" action="${DEVICE_VERIFY_PATH}">`,
    `<input type="hidden" name="form_token" value="${escapeHtml(o.form)}">`,
    `<label>${escapeHtml(t.device.codeLabel)}<input type="text" name="user_code" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" required value="${escapeHtml(o.code)}"></label>`,
    `<p class="hint">${escapeHtml(t.device.codeHint)}</p>`,
    `<button type="submit" name="decision" value="approve">${escapeHtml(t.device.approve)}</button>`,
    `<button type="submit" name="decision" value="deny">${escapeHtml(t.device.deny)}</button>`,
    "</form>",
  );
  return page(t, parts.join("\n"), t.device.title);
}

/** Answers `GET` and `POST /oauth/device/verify`; gives the status sent. Other methods: 405. */
export async function handleDeviceVerify(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DevicePageContext,
): Promise<number> {
  const t = oauthTexts(langOf(req.headers["accept-language"]));
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" });
    res.end();
    return 405;
  }
  const url = new URL(req.url ?? "/", "http://x");
  const returnTo = safeReturnTo(`${DEVICE_VERIFY_PATH}${url.search}`);
  if (returnTo === undefined) return errorPage(res, t, 400, t.errors.tooLong);
  const now = ctx.now();

  const form = req.method === "POST" ? await readForm(req) : undefined;
  const ident: IdentityRequest = {
    method: req.method,
    path: url.pathname,
    query: fieldsOf(url.searchParams),
    headers: headersOf(req),
    cookies: cookiesOf(req.headers.cookie),
    remote: ctx.remote(req),
    ...(form === undefined ? {} : { form: fieldsOf(form) }),
  };
  const who = await ctx.identity.currentUser(ident);
  // A login that ends before the CLI's next poll would give an approval that fails at the token
  // endpoint: sign in again first, on GET and on the answer alike.
  if (who === undefined || Date.parse(who.expiresAt) - Date.parse(now) < CODE_SECONDS * 1000) {
    return identityResponse(res, await ctx.identity.beginLogin(ident, returnTo));
  }
  if ((await ctx.identity.userState(who.user)) !== "active") {
    return errorPage(res, t, 403, t.errors.user);
  }
  const tenant = await ctx.deps.control.tenantOf(who.user);
  if (tenant === undefined || tenant.state !== "active") {
    return errorPage(res, t, 403, t.errors.tenant);
  }

  /** The form again, with a new one-time token bound to this sign-in. */
  const show = async (status: number, code: string, problem?: string) => {
    const token = randomBytes(32).toString("base64url");
    await ctx.deps.store.putForm(
      tokenHash(token),
      formBinding(who.session),
      new Date(Date.parse(now) + FORM_SECONDS * 1000).toISOString(),
    );
    return sendPage(
      res,
      status,
      verifyPage(t, {
        userName: who.name,
        form: token,
        code,
        ...(problem === undefined ? {} : { problem }),
      }),
    );
  };

  if (req.method === "GET") {
    const given = url.searchParams.getAll("user_code");
    return show(200, given.length === 1 ? (given[0] as string).slice(0, 20) : "");
  }

  // POST: the form token first, then the decision, then the code.
  const token = form?.getAll("form_token");
  if (
    form === undefined ||
    token === undefined ||
    token.length !== 1 ||
    !(await ctx.deps.store.useForm(tokenHash(token[0] as string), formBinding(who.session), now))
  ) {
    return errorPage(res, t, 403, t.errors.form);
  }
  const decision = form.getAll("decision");
  const typed = form.getAll("user_code");
  if (
    decision.length !== 1 ||
    (decision[0] !== "approve" && decision[0] !== "deny") ||
    typed.length !== 1
  ) {
    return errorPage(res, t, 400, t.errors.form);
  }
  const shown = (typed[0] as string).slice(0, 20);

  const tries = ctx.deviceTries ?? PROCESS_TRIES;
  const source = ctx.remote(req);
  const at = Date.parse(now);
  // Taken before anything is awaited: tries sent at once each find the count as the one before
  // left it.
  if (!tries.take(who.session, source, at)) return show(429, shown, t.device.limited);
  const userCode = readUserCode(shown);
  const answered =
    userCode !== undefined &&
    (await answerDeviceCode(ctx.deps, {
      userCode,
      approved: decision[0] === "approve",
      user: who.user,
      login: who.session,
      tenant: tenant.id,
      now,
    }));
  if (!answered) return show(400, shown, t.device.wrongCode);
  tries.giveBack(who.session, source);
  const done = decision[0] === "approve" ? t.device.approved : t.device.denied;
  return sendPage(
    res,
    200,
    page(t, `<h1>${escapeHtml(t.device.title)}</h1><p>${escapeHtml(done)}</p>`, t.device.title),
  );
}
