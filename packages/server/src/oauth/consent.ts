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
// never framed, never cached, send a referrer only to this service (so that a form posted here
// carries its `Origin`), and the redirect to the client carries none. The consent page's forms may
// go to this service and to the origin of the request's redirect URI: a browser checks the redirect
// after the answer against `form-action` too. Whatever a client or a user wrote is escaped.
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
import { HANDHELD_IMAGE } from "./handheld.ts";
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

/** The pages' content security policy; `formSource`, a source `form-action` allows besides 'self'. */
function contentSecurityPolicy(formSource?: string): string {
  const forms = formSource === undefined ? "'self'" : `'self' ${formSource}`;
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action ${forms}; frame-ancestors 'none'; base-uri 'none'`;
}

/** Headers of every page of the authorization server. */
export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  pragma: "no-cache",
  "content-security-policy": contentSecurityPolicy(),
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
} as const;

/**
 * The source of a redirect URI that already matched the client's, as `form-action` writes it: the
 * origin of an `http` or `https` URI, the scheme of another (`com.example.app:`). Undefined for one
 * that is neither, so nothing of the URI but these is ever written into a header.
 */
export function redirectSource(redirectUri: string): string | undefined {
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return undefined;
  }
  if (u.protocol === "http:" || u.protocol === "https:") {
    return /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(u.origin) ? u.origin : undefined;
  }
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) ? u.protocol : undefined;
}

/** The brand mark: four bars around an amber centre. */
const MARK =
  '<svg width="23" height="23" viewBox="0 0 23 23" aria-hidden="true"><rect width="15" height="7" rx="2" fill="#bcaaf2"/><rect x="16" width="7" height="15" rx="2" fill="#92daa8"/><rect x="8" y="8" width="7" height="7" rx="2" fill="#f2b33d"/><rect y="8" width="7" height="15" rx="2" fill="#8dcfe7"/><rect x="8" y="16" width="15" height="7" rx="2" fill="#f9806b"/></svg>';

/**
 * The pages' look: a white card on a softly lit ground, the handheld at its corner, amber for the
 * one main button. Everything is in the page itself: it loads no font, style or image.
 */
const STYLE = `*{box-sizing:border-box}
html{color-scheme:light;min-height:100%;background:#fdfbf6 radial-gradient(120% 90% at 70% 40%,#fff 0%,#fdfbf6 60%,#f9f4ea 100%) no-repeat}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;color:#161a2b;font:14.5px/1.6 Geist,"Noto Sans SC",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
header{display:flex;align-items:center;gap:9px;padding:20px 24px;font-size:19px;font-weight:700;letter-spacing:-.02em}
main{flex:1;display:grid;justify-items:center;align-items:start;padding:clamp(64px,9vh,88px) 16px 56px}
.card{position:relative;width:min(100%,440px);display:flex;flex-direction:column;gap:16px;padding:34px;background:#fff;border-radius:20px;box-shadow:0 0 0 1px rgba(22,26,43,.1)}
.handheld{position:absolute;right:-64px;top:-104px;width:112px;pointer-events:none}
.screen{position:absolute;right:-48px;top:-71px;width:87px;height:56px;display:grid;place-items:center;font:700 19px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.06em;color:#f2c35a;pointer-events:none}
h1{margin:0 36px 0 0;font-size:26px;font-weight:600;line-height:1.25;letter-spacing:-.02em;overflow-wrap:anywhere}
p{margin:0}
.sub{font-size:15px;color:#5b5d65;overflow-wrap:anywhere}
.sub strong{color:#161a2b;font-weight:600}
.fine{font-size:13px;line-height:1.55;color:#6b6b72;overflow-wrap:anywhere}
.note{padding:12px 16px;border-radius:10px;background:#f6f4f0;font-size:14px}
.note.bad{background:#fbe0dd}
form{display:flex;flex-direction:column;gap:16px;margin:0}
.field{display:grid;gap:6px;font-size:13px;font-weight:700}
input[type=text]{width:100%;font:inherit;font-size:15px;font-weight:500;color:inherit;background:#fff;border:1px solid #e6e4df;border-radius:10px;padding:11px 14px;outline:0}
input[type=text]:focus-visible{outline:3px solid #161a2b;outline-offset:2px}
fieldset{margin:0;padding:0;border:0;min-width:0}
legend{padding:0;margin-bottom:4px;font-size:13px;font-weight:700}
.scope{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #f0ede7;cursor:pointer}
.scope:last-child{border-bottom:0}
.scope span{flex:1}
input[type=checkbox]{width:18px;height:18px;margin:0;accent-color:#161a2b;flex:none}
input[type=checkbox]:disabled+span{color:#6b6b72}
.risk{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:999px;background:#fbe0dd;color:#b3281d;font-size:12px;font-weight:700;flex:none}
details summary{width:fit-content;cursor:pointer;font-size:13px;color:#5b5d65}
details .field{margin:10px 0 6px}
.actions{display:flex;flex-direction:row-reverse;gap:10px;margin-top:4px}
button{font:inherit;font-size:15px;font-weight:700;line-height:1.2;color:#161a2b;padding:11px 20px;border:0;border-radius:10px;background:#fff;box-shadow:inset 0 0 0 1px rgba(22,26,43,.16);cursor:pointer;transition:background .12s,box-shadow .12s}
button:hover{box-shadow:inset 0 0 0 1px rgba(22,26,43,.28)}
button.primary{background:#f2b33d;box-shadow:none}
button.primary:hover{background:#dda436}
:focus-visible{outline:3px solid #161a2b;outline-offset:3px}
@media (max-width:760px){
main{padding:104px 12px 32px}
.card{padding:24px}
.handheld{right:8px;top:-112px;width:80px}
.screen{right:19px;top:-95px;width:62px;height:40px;font-size:14px}
h1{margin-right:0;font-size:22px}
.actions button{flex:1}
}`;

/**
 * A page of the authorization server: `body` is HTML made by the caller, escaped where it must be,
 * and goes in the card. `screen`, a few ASCII letters for the handheld's screen.
 */
export function page(t: OAuthTexts, body: string, title: string = t.title, screen = ""): string {
  return `<!doctype html>
<html lang="${t.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head><body><header>${MARK}saveslot</header>
<main><div class="card"><img class="handheld" src="${HANDHELD_IMAGE}" alt="">${screen === "" ? "" : `<span class="screen" aria-hidden="true">${escapeHtml(screen)}</span>`}
${body}
</div></main></body></html>`;
}

export function sendPage(
  res: ServerResponse,
  status: number,
  html: string,
  cookies: readonly SetCookie[] = [],
  extra: readonly (readonly [string, string])[] = [],
  formSource?: string,
): number {
  res.writeHead(status, {
    ...Object.fromEntries(extra),
    ...PAGE_HEADERS,
    ...(formSource === undefined
      ? {}
      : { "content-security-policy": contentSecurityPolicy(formSource) }),
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
    page(t, `<h1>${escapeHtml(t.errorTitle)}</h1><p class="sub">${escapeHtml(message)}</p>`),
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
  if (r.client.builtIn) {
    parts.push(`<p class="sub">${escapeHtml(t.cliAsks)}</p>`);
  } else {
    parts.push(
      // The host is the client's only identity, the name is its own claim (05 §15): the host is
      // shown at least as plainly as the name.
      `<p class="sub">${t.asksAccess(`<strong>${escapeHtml(r.client.name)}</strong>`, `<strong>${escapeHtml(r.client.host ?? "")}</strong>`)}</p>`,
    );
  }
  if (s.problem !== undefined) {
    parts.push(`<p class="note bad" role="alert">${escapeHtml(s.problem)}</p>`);
  }
  parts.push(`<form method="post" action="${action}">`);
  parts.push(`<input type="hidden" name="form_token" value="${escapeHtml(form)}">`);
  if (!r.client.builtIn) {
    const offered = r.scopes ?? DEFAULT_SCOPES;
    // Shown first, ticked are the default scopes the client asked for (05 §15: read and write);
    // making schemas and deleting are offered when asked for, never ticked for the user, and
    // marked as the ones to think twice about.
    const ticked = s.ticked ?? offered.filter((x) => DEFAULT_SCOPES.includes(x));
    parts.push(`<fieldset><legend>${escapeHtml(t.scopesLabel)}</legend>`);
    for (const scope of SCOPES.filter((x) => offered.includes(x))) {
      if (scope === "saveslot.read") {
        // Always granted (contract §12): shown ticked, sent as a hidden field.
        parts.push(
          `<label class="scope"><input type="checkbox" checked disabled><span>${escapeHtml(t.scope[scope])}</span></label>`,
          `<input type="hidden" name="scope" value="saveslot.read">`,
        );
      } else {
        const risk = DEFAULT_SCOPES.includes(scope)
          ? ""
          : '<b class="risk" aria-hidden="true">!</b>';
        parts.push(
          `<label class="scope"><input type="checkbox" name="scope" value="${scope}"${ticked.includes(scope) ? " checked" : ""}><span>${escapeHtml(t.scope[scope])}</span>${risk}</label>`,
        );
      }
    }
    parts.push(
      `</fieldset><p class="fine">${escapeHtml(t.allSlots)}</p>`,
      // The name is filled in already; a problem with the one sent shows it open.
      `<details${s.problem === undefined ? "" : " open"}><summary>${escapeHtml(t.nameLabel)}</summary>`,
      `<label class="field"><input type="text" name="name" maxlength="100" required value="${escapeHtml(s.name ?? "")}" aria-describedby="name-hint"></label>`,
      `<p class="fine" id="name-hint">${escapeHtml(t.nameHint)}</p></details>`,
    );
  }
  parts.push(
    // Who answers and where the answer goes: in the form, right above its buttons.
    `<p class="fine">${escapeHtml(t.signedInAs(s.userName))}${t.gap}${escapeHtml(t.redirectsTo(new URL(r.redirectUri).host || r.redirectUri))}</p>`,
    // The answer that Enter gives comes first; the row shows it on the right.
    '<div class="actions">',
    `<button type="submit" class="primary" name="decision" value="allow">${escapeHtml(r.client.builtIn ? t.allowCli : t.allow)}</button>`,
    `<button type="submit" name="decision" value="deny">${escapeHtml(t.deny)}</button>`,
    "</div></form>",
  );
  return sendPage(
    res,
    200,
    page(t, parts.join("\n"), t.title, "OK?"),
    [],
    [],
    redirectSource(r.redirectUri),
  );
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
    resolveClient: (id) => resolveClient(ctx.deps, id, now, ctx.remote(req)),
  });
  if ("kind" in checked) {
    if (checked.kind === "redirect") return redirect(res, checked.to);
    // Bounded fetches: not the client's fault, so not its error page.
    if (checked.client === "fetch_limited") return errorPage(res, t, 429, t.errors.clientLimited);
    if (checked.client === "fetch_busy") return errorPage(res, t, 503, t.errors.clientBusy);
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
