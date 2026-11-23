// The authorization page (docs/zh-CN/spec/05-surfaces.md §15 «远程授权»): `GET /oauth/authorize`
// shows the request to the user who is signed in, `POST /oauth/authorize` takes the answer.
//
// Who the user is comes from the identity provider (02-architecture §12): signing in, its cookie and
// its form are the provider's. The page asks it for the current user and, when there is none, for
// the response that starts a sign-in with the whole request as the way back. Every request,
// GET or POST, is checked again from its query (client document, redirect URI, PKCE, scopes,
// resource): nothing of an earlier check is trusted.
//
// The answer form carries a one-time token bound to the provider's sign-in (`session`) and to the
// request the page was shown for (its query): a page of one sign-in cannot be answered under
// another, a sign-out leaves its forms useless, and a token cannot answer another request. Pages are
// never framed, never cached, never send a referrer; whatever a client or a user wrote is escaped.
// Cookies and form fields are read through Maps and URLSearchParams only.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type AuthorizationRequest,
  CODE_SECONDS,
  checkAuthorizationRequest,
  connectionNameOk,
  connectionNameTaken,
  consentScopes,
  DEFAULT_SCOPES,
  escapeHtml,
  type IdentityProvider,
  type IdentityRequest,
  type IdentityResponse,
  issueCode,
  type OAuthDeps,
  redirectWith,
  resolveClient,
  SCOPES,
  type Scope,
  type SetCookie,
  safeReturnTo,
  setCookieHeader,
  type TenantId,
  tokenHash,
} from "@fluxvita/saveslot-service";
import { langOf, type OAuthTexts, oauthTexts } from "./texts.ts";

/** The authorization page's path. */
const OAUTH_AUTHORIZE = "/oauth/authorize";
/** The answer form's body limit. */
export const CONSENT_BODY_MAX_BYTES = 16 * 1024;
/** How long an answer form stays good. */
export const FORM_SECONDS = 10 * 60;

export interface ConsentContext {
  readonly deps: OAuthDeps;
  readonly identity: IdentityProvider;
  readonly now: () => string;
  /** The source address of a request (behind trusted proxies). */
  readonly remote: (req: IncomingMessage) => string;
  readonly warn: (event: string, fields: Readonly<Record<string, string>>) => void;
}

/** The cookies of a request, by name; the first of a name wins. */
export function cookiesOf(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (name !== "" && !out.has(name)) out.set(name, part.slice(i + 1).trim());
  }
  return out;
}

/** The first value of each name of a query or form, as the provider reads it. */
export function fieldsOf(params: URLSearchParams): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of params) if (!out.has(k)) out.set(k, v);
  return out;
}

export function headersOf(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") out.set(k, v);
    else if (Array.isArray(v)) out.set(k, v.join(", "));
  }
  return out;
}

/** Headers of every page of the authorization server. */
export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  pragma: "no-cache",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

/** A page of the authorization server: `body` is HTML made by the caller, escaped where it must be. */
export function page(t: OAuthTexts, body: string, title: string = t.title): string {
  return `<!doctype html>
<html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:.5rem 0}input[type=text]{width:100%;font:inherit;padding:.3rem}button{font:inherit;padding:.4rem 1rem;margin:.75rem .5rem 0 0}.hint{color:#555;font-size:.9em}.error{color:#a00}</style>
</head><body>${body}</body></html>`;
}

export function sendPage(
  res: ServerResponse,
  status: number,
  html: string,
  cookies: readonly SetCookie[] = [],
  extra: readonly (readonly [string, string])[] = [],
): number {
  res.writeHead(status, {
    ...Object.fromEntries(extra),
    ...PAGE_HEADERS,
    "content-length": Buffer.byteLength(html),
    ...(cookies.length === 0 ? {} : { "set-cookie": cookies.map(setCookieHeader) }),
  });
  res.end(html);
  return status;
}

export function errorPage(
  res: ServerResponse,
  t: OAuthTexts,
  status: number,
  message: string,
): number {
  return sendPage(
    res,
    status,
    page(t, `<h1>${escapeHtml(t.errorTitle)}</h1><p>${escapeHtml(message)}</p>`),
  );
}

export function redirect(
  res: ServerResponse,
  location: string,
  cookies: readonly SetCookie[] = [],
): number {
  res.writeHead(302, {
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...(cookies.length === 0 ? {} : { "set-cookie": cookies.map(setCookieHeader) }),
  });
  res.end();
  return 302;
}

export function identityResponse(res: ServerResponse, r: IdentityResponse): number {
  return r.kind === "redirect"
    ? redirect(res, r.location, r.cookies)
    : sendPage(res, r.status, r.html, r.cookies, r.headers);
}

/** An answer form of at most `CONSENT_BODY_MAX_BYTES`; undefined when it is not one. */
export async function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > CONSENT_BODY_MAX_BYTES) return undefined;
    chunks.push(c);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** A name not yet used in the tenant: the client's, or it with a number after it. */
async function freeName(ctx: ConsentContext, tenant: TenantId, wanted: string): Promise<string> {
  return ctx.deps.pool.use(tenant, async (t) => {
    const base = connectionNameOk(wanted) ? wanted : "Agent";
    if (!(await connectionNameTaken(t.store, base))) return base;
    for (let i = 2; i < 100; i++) {
      const n = `${base} (${i})`;
      if (connectionNameOk(n) && !(await connectionNameTaken(t.store, n))) return n;
    }
    return base;
  });
}

/** What an answer form's token is bound to: the sign-in, and the request the page was shown for. */
function formBinding(session: string, query: string): string {
  return `${session} ${tokenHash(query)}`;
}

interface Shown {
  readonly request: AuthorizationRequest;
  readonly query: string;
  readonly userName: string;
  readonly session: string;
  readonly name?: string;
  readonly ticked?: readonly string[];
  readonly problem?: string;
}

/** The consent page, with a new one-time form token. */
async function consentPage(
  ctx: ConsentContext,
  res: ServerResponse,
  t: OAuthTexts,
  s: Shown,
): Promise<number> {
  const form = randomBytes(32).toString("base64url");
  const now = ctx.now();
  await ctx.deps.store.putForm(
    tokenHash(form),
    formBinding(s.session, s.query),
    new Date(Date.parse(now) + FORM_SECONDS * 1000).toISOString(),
  );
  const r = s.request;
  const action = `${OAUTH_AUTHORIZE}?${escapeHtml(s.query)}`;
  const parts: string[] = [`<h1>${escapeHtml(t.title)}</h1>`];
  parts.push(`<p>${escapeHtml(t.signedInAs(s.userName))}</p>`);
  if (r.client.builtIn) {
    parts.push(`<p>${escapeHtml(t.cliAsks)}</p>`);
  } else {
    parts.push(
      `<p>${t.asksAccess(`<strong>${escapeHtml(r.client.name)}</strong>`, `<strong>${escapeHtml(r.client.host ?? "")}</strong>`)}</p>`,
    );
  }
  parts.push(
    `<p class="hint">${escapeHtml(t.redirectsTo(new URL(r.redirectUri).host || r.redirectUri))}</p>`,
  );
  if (s.problem !== undefined) parts.push(`<p class="error">${escapeHtml(s.problem)}</p>`);
  parts.push(`<form method="post" action="${action}">`);
  parts.push(`<input type="hidden" name="form_token" value="${escapeHtml(form)}">`);
  if (!r.client.builtIn) {
    const offered = r.scopes ?? DEFAULT_SCOPES;
    const ticked = s.ticked ?? offered;
    parts.push(
      `<label>${escapeHtml(t.nameLabel)}<input type="text" name="name" maxlength="100" required value="${escapeHtml(s.name ?? "")}"></label>`,
      `<p class="hint">${escapeHtml(t.nameHint)}</p>`,
      `<fieldset><legend>${escapeHtml(t.scopesLabel)}</legend>`,
    );
    for (const scope of SCOPES.filter((x) => offered.includes(x))) {
      if (scope === "saveslot.read") {
        // Always granted (contract §12): shown ticked, sent as a hidden field.
        parts.push(
          `<label><input type="checkbox" checked disabled> ${escapeHtml(t.scope[scope])}</label>`,
          `<input type="hidden" name="scope" value="saveslot.read">`,
        );
      } else {
        parts.push(
          `<label><input type="checkbox" name="scope" value="${scope}"${ticked.includes(scope) ? " checked" : ""}> ${escapeHtml(t.scope[scope])}</label>`,
        );
      }
    }
    parts.push(
      `</fieldset><p class="hint">${escapeHtml(t.readRequired)} ${escapeHtml(t.allSlots)}</p>`,
    );
  }
  parts.push(
    `<button type="submit" name="decision" value="allow">${escapeHtml(r.client.builtIn ? t.allowCli : t.allow)}</button>`,
    `<button type="submit" name="decision" value="deny">${escapeHtml(t.deny)}</button>`,
    "</form>",
  );
  return sendPage(res, 200, page(t, parts.join("\n")));
}

/**
 * Answers `GET` and `POST /oauth/authorize`; gives the status sent. Other methods: 405.
 */
export async function handleAuthorize(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ConsentContext,
): Promise<number> {
  const t = oauthTexts(langOf(req.headers["accept-language"]));
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" });
    res.end();
    return 405;
  }
  const url = new URL(req.url ?? "/", "http://local");
  const query = url.search.slice(1);
  // The whole request goes through the sign-in as the way back: refused here when it cannot.
  const returnTo = safeReturnTo(`${OAUTH_AUTHORIZE}?${query}`);
  if (returnTo === undefined) return errorPage(res, t, 400, t.errors.tooLong);
  const now = ctx.now();

  const checked = await checkAuthorizationRequest({
    query: new URLSearchParams(query),
    external: ctx.deps.external,
    resolveClient: (id) => resolveClient(ctx.deps, id, now),
  });
  if ("kind" in checked) {
    if (checked.kind === "redirect") return redirect(res, checked.to);
    return errorPage(
      res,
      t,
      400,
      checked.reason === "client" ? t.errors.client : t.errors.redirect,
    );
  }
  const r = checked;

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
  // A login that ends before a code could be redeemed would give a code that fails at the token
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

  if (req.method === "GET") {
    return consentPage(ctx, res, t, {
      request: r,
      query,
      userName: who.name,
      session: who.session,
      ...(r.client.builtIn ? {} : { name: await freeName(ctx, tenant.id, r.client.name) }),
    });
  }

  // POST: the answer. The form token first: a form not shown to this sign-in is refused.
  const token = form?.getAll("form_token");
  if (
    form === undefined ||
    token === undefined ||
    token.length !== 1 ||
    !(await ctx.deps.store.useForm(
      tokenHash(token[0] as string),
      formBinding(who.session, query),
      now,
    ))
  ) {
    return errorPage(res, t, 403, t.errors.form);
  }
  const decision = form.getAll("decision");
  if (decision.length !== 1 || (decision[0] !== "allow" && decision[0] !== "deny")) {
    return errorPage(res, t, 400, t.errors.form);
  }
  if (decision[0] === "deny") {
    return redirect(
      res,
      redirectWith(r.redirectUri, {
        error: "access_denied",
        state: r.state,
        iss: ctx.deps.external,
      }),
    );
  }

  let scopes: Scope[];
  let name: string | undefined;
  if (r.client.builtIn) {
    scopes = [...SCOPES];
  } else {
    const ticked = form.getAll("scope");
    const given = consentScopes(ticked, r.scopes);
    if (given === undefined) return errorPage(res, t, 400, t.errors.scopes);
    scopes = given;
    const names = form.getAll("name");
    const wanted = names.length === 1 ? (names[0] as string).trim() : "";
    const again = (problem: string) =>
      consentPage(ctx, res, t, {
        request: r,
        query,
        userName: who.name,
        session: who.session,
        name: wanted,
        ticked: given,
        problem,
      });
    if (!connectionNameOk(wanted)) return again(t.errors.name);
    const taken = await ctx.deps.pool.use(tenant.id, (o) => connectionNameTaken(o.store, wanted));
    if (taken) return again(t.errors.nameTaken);
    name = wanted;
  }

  const code = await issueCode(ctx.deps, {
    client: r.client,
    redirectUri: r.redirectUri,
    codeChallenge: r.codeChallenge,
    resource: r.resource,
    user: who.user,
    login: who.session,
    tenant: tenant.id,
    ...(r.scopes === undefined ? {} : { requestedScopes: r.scopes }),
    scopes,
    ...(name === undefined ? {} : { name }),
    now,
  });
  return redirect(
    res,
    redirectWith(r.redirectUri, { code, state: r.state, iss: ctx.deps.external }),
  );
}
