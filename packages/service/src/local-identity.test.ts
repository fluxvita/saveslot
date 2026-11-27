// The local accounts as the identity provider (02-architecture §9, §12): names like `__proto__`, the
// login form with its one-time token, the two counts of failed logins, the login state and the
// account's state; a login written only if the password compared is still the account's; the queue
// of password checks, its cap and its time limit; a user session issued from a live login only, its
// locks taken in the order every change of the account keeps.
// Fictional names and passwords.

import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { validateHeaderValue } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomCrockford, type TenantStore } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import type { TenantId } from "./control-plane.ts";
import { CursorKeys, type DerivedKeys } from "./cursor.ts";
import { type IdentityRequest, type IdentityResponse, UserSessionError } from "./identity.ts";
import {
  disableLocalUser,
  enableLocalUser,
  initLocalAccounts,
  LocalAccounts,
  setLocalPassword,
} from "./local-accounts.ts";
import {
  FORM_COOKIE,
  LOGIN_COOKIE,
  LOGIN_FORM_PURPOSE,
  LocalIdentity,
  PER_WIDE_SOURCE,
} from "./local-identity.ts";
import {
  hashPassword,
  PasswordChecksBusy,
  SCRYPT_WAIT_MAX,
  SCRYPT_WAIT_MS,
  scryptLoadForTests,
  scryptPlacesForTests,
  useScryptForTests,
  useScryptWaitForTests,
} from "./local-passwords.ts";
import {
  type ControlDb,
  initControlPlane,
  type ServerControlPlane,
} from "./server-control-plane.ts";
import { tokenHash } from "./tokens.ts";

const T = 120_000;
const NOW = "2026-11-20T10:00:00.000Z";
const root = mkdtempSync(join(tmpdir(), "saveslot-local-identity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

let db: TenantStore;
let cp: ServerControlPlane;
// The deployment's handle key file, and the form keys every process derives from it.
const KEY_FILE = join(root, "handle-keys.json");
let FORM_KEYS: DerivedKeys;
let accounts: LocalAccounts;
let clock = Date.parse(NOW);
const id = () =>
  new LocalIdentity({
    accounts,
    loginMs: 60 * 60_000,
    origin: ORIGIN,
    formKeys: FORM_KEYS,
    now: () => clock,
  });
beforeAll(async () => {
  await CursorKeys.createFile(KEY_FILE);
  FORM_KEYS = (await CursorKeys.fromFile(KEY_FILE)).derive(LOGIN_FORM_PURPOSE);
  useScryptForTests({ N: 2 ** 10, r: 8, p: 1 });
  db = await testBackend().open({ kind: "pglite", dir: join(root, "control") }, { create: true });
  cp = await initControlPlane(db);
  accounts = await initLocalAccounts(db);
}, T);
afterAll(async () => {
  await db?.close();
}, T);

let names = 0;
const PASSWORD = "correct horse battery";
/** An account, made directly in its table: a login needs no tenant. */
async function account(): Promise<{ name: string; user: `u_${string}` }> {
  const name = `person${++names}`;
  const user = `u_${randomCrockford(26)}` as const;
  const hash = await hashPassword(PASSWORD);
  await db.write((tx) =>
    tx.query(
      "INSERT INTO accounts (id, name, password_hash, state) VALUES ($1, $2, $3, 'active')",
      [user, name, hash],
    ),
  );
  return { name, user };
}

function request(
  o: Omit<Partial<IdentityRequest>, "form"> & { form?: Record<string, string> },
): IdentityRequest {
  const { form, ...rest } = o;
  return {
    method: "GET",
    path: "/",
    query: new Map(),
    headers: new Map(),
    cookies: new Map(),
    remote: "198.51.100.7",
    ...rest,
    ...(form === undefined ? {} : { form: new Map(Object.entries(form)) }),
  };
}

const TO = "/oauth/authorize?client_id=c";

const ORIGIN = "https://saveslot.example";
const FORM = `__Host-${FORM_COOKIE}`;
/** Each form token to the form cookie its page set: what the browser that fetched it sends back. */
const browsers = new Map<string, string>();

/** The login form's one-time token, from the page; its browser keeps the page's form cookie. */
async function formToken(
  p: LocalIdentity,
  remote = "198.51.100.7",
  cookies: ReadonlyMap<string, string> = new Map(),
): Promise<string> {
  const page = await p.handle(
    request({ path: "/account/login", query: new Map([["return_to", TO]]), remote, cookies }),
  );
  const m = page?.kind === "page" ? /name="form_token" value="([^"]+)"/.exec(page.html) : null;
  const cookie = page?.cookies?.find((c) => c.name === FORM)?.value;
  if (m === null || cookie === undefined) throw new Error("no form token on the page");
  browsers.set(m[1] as string, cookie);
  return m[1] as string;
}

/**
 * Posts the login form from the browser that fetched its token, unless `cookie` says what form
 * cookie it carries (null: none); with `origin`, the request's `Origin`.
 */
async function post(
  p: LocalIdentity,
  form: Record<string, string>,
  remote = "198.51.100.7",
  o: { readonly cookie?: string | null; readonly origin?: string } = {},
): Promise<IdentityResponse | undefined> {
  const cookie = o.cookie === undefined ? browsers.get(form["form_token"] ?? "") : o.cookie;
  return p.handle(
    request({
      method: "POST",
      path: "/account/login",
      form,
      remote,
      cookies: new Map(cookie === null || cookie === undefined ? [] : [[FORM, cookie]]),
      headers: new Map(o.origin === undefined ? [] : [["origin", o.origin]]),
    }),
  );
}

const status = (r: IdentityResponse | undefined) => (r?.kind === "page" ? r.status : r?.kind);
const header = (r: IdentityResponse | undefined, name: string) =>
  r?.headers?.find(([k]) => k === name)?.[1];
/** The page over `db` in place of the accounts' own database. */
const over = (db: ControlDb) =>
  new LocalIdentity({
    accounts: LocalAccounts.over(db),
    loginMs: 60 * 60_000,
    origin: ORIGIN,
    formKeys: FORM_KEYS,
    now: () => clock,
  });
const loginsOf = async (user: string) =>
  (await db.read((tx) => tx.query("SELECT 1 FROM web_logins WHERE user_id = $1", [user]))).rows
    .length;
const loginCookie = (r: IdentityResponse | undefined) =>
  r?.kind === "redirect" ? r.cookies?.find((c) => c.name === LOGIN_COOKIE)?.value : undefined;

describe("the local accounts' login", () => {
  it(
    "shows a page that loads nothing, may not be framed, in the browser's language, with a form token",
    async () => {
      const p = id();
      const en = await p.handle(
        request({ path: "/account/login", query: new Map([["return_to", TO]]) }),
      );
      const headers = en?.kind === "page" ? en.headers : undefined;
      expect(headers).toEqual(
        expect.arrayContaining([
          ["x-frame-options", "DENY"],
          [
            "content-security-policy",
            "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
          ],
          ["x-content-type-options", "nosniff"],
          ["referrer-policy", "same-origin"],
          ["cache-control", "no-store"],
        ]),
      );
      expect(en?.kind === "page" && en.html).toContain("Sign in to saveslot");
      const zh = await p.handle(
        request({
          path: "/account/login",
          query: new Map([["return_to", TO]]),
          headers: new Map([["accept-language", "zh-CN"]]),
        }),
      );
      expect(zh?.kind === "page" && zh.html).toContain("登录 saveslot");
      expect(
        await p.handle(
          request({ path: "/account/login", query: new Map([["return_to", "//x/"]]) }),
        ),
      ).toMatchObject({ kind: "page", status: 400 });
    },
    T,
  );

  it(
    "signs a person in and sends them back; the login is then the current user's, with its expiry",
    async () => {
      const a = await account();
      const p = id();
      const signedIn = clock;
      const r = await post(p, {
        form_token: await formToken(p),
        return_to: TO,
        name: a.name,
        password: PASSWORD,
      });
      expect(r).toMatchObject({ kind: "redirect", location: TO });
      const cookie = loginCookie(r) as string;
      const who = await p.currentUser(request({ cookies: new Map([[LOGIN_COOKIE, cookie]]) }));
      expect(who).toMatchObject({
        user: a.user,
        name: a.name,
        expiresAt: new Date(signedIn + 60 * 60_000).toISOString(),
      });
      expect(who?.session).not.toBe(cookie);
    },
    T,
  );

  it(
    "a key added to the file and made current: forms made before still taken, new ones under it; a handle key's own MAC is not a form token",
    async () => {
      const a = await account();
      const before = id();
      const old = await formToken(before);
      // The file with a second key, made current, the first kept (the first step of a change).
      const file = JSON.parse(readFileSync(KEY_FILE, "utf8")) as {
        current: string;
        keys: { id: string; secret: string }[];
      };
      const added = { id: `k${"7".repeat(16)}`, secret: "ab".repeat(32) };
      const both = join(root, `both-keys-${clock}.json`);
      writeFileSync(
        both,
        `${JSON.stringify({ format: 1, current: added.id, keys: [...file.keys, added] })}\n`,
        { mode: 0o600 },
      );
      const after = new LocalIdentity({
        accounts,
        loginMs: 60 * 60_000,
        origin: ORIGIN,
        formKeys: (await CursorKeys.fromFile(both)).derive(LOGIN_FORM_PURPOSE),
        now: () => clock,
      });
      const wrong = { return_to: TO, name: a.name, password: "wrong one here" };
      expect(status(await post(after, { ...wrong, form_token: old }))).toBe(401);
      const made = await formToken(after);
      expect(made.split(".")[1]).toBe(added.id);
      // The process still on the first file does not know the new key yet.
      expect(status(await post(before, { ...wrong, form_token: made, password: PASSWORD }))).toBe(
        400,
      );
      // The derived key is not the handle key: an HMAC under the key itself is refused.
      const [until] = made.split(".") as [string];
      const binding = browsers.get(made) as string;
      const raw = createHmac("sha256", Buffer.from(added.secret, "hex"))
        .update(`${added.id}.${binding}.${until}`)
        .digest("base64url");
      const forged = `${until}.${added.id}.${raw}`;
      browsers.set(forged, binding);
      expect(status(await post(after, { ...wrong, form_token: forged, password: PASSWORD }))).toBe(
        400,
      );
      expect(FORM_KEYS.byId.get(file.current)?.toString("hex")).not.toBe(
        file.keys.find((k) => k.id === file.current)?.secret,
      );
    },
    T,
  );

  it(
    "takes a form token with its cookie until it expires, not after, and not under another key file",
    async () => {
      const a = await account();
      const p = id();
      const token = await formToken(p);
      const wrong = { form_token: token, return_to: TO, name: a.name, password: "wrong one here" };
      // Within its 30 minutes, the same token with its cookie is taken again.
      expect(status(await post(p, wrong))).toBe(401);
      expect(status(await post(p, wrong))).toBe(401);
      clock += 30 * 60_000;
      try {
        expect(status(await post(p, { ...wrong, password: PASSWORD }))).toBe(400);
      } finally {
        clock -= 30 * 60_000;
      }
      // Another process of the deployment (or this one restarted) reads the same key file: taken.
      const fresh = await formToken(p);
      const other = new LocalIdentity({
        accounts,
        loginMs: 60 * 60_000,
        origin: ORIGIN,
        formKeys: (await CursorKeys.fromFile(KEY_FILE)).derive(LOGIN_FORM_PURPOSE),
        now: () => clock,
      });
      expect(status(await post(other, { ...wrong, form_token: fresh }))).toBe(401);
      // One with another key file: not taken.
      const elsewhere = join(root, `other-keys-${clock}.json`);
      await CursorKeys.createFile(elsewhere);
      const stranger = new LocalIdentity({
        accounts,
        loginMs: 60 * 60_000,
        origin: ORIGIN,
        formKeys: (await CursorKeys.fromFile(elsewhere)).derive(LOGIN_FORM_PURPOSE),
        now: () => clock,
      });
      expect(
        status(await post(stranger, { ...wrong, form_token: fresh, password: PASSWORD })),
      ).toBe(400);
      // A token changed by a character, one whose expiry was moved, one naming another key, or one
      // of the earlier form (no key ID), is not taken.
      const [until, kid, mac] = fresh.split(".") as [string, string, string];
      const flipped = `${until}.${kid}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
      const later = `${Number(until) + 1000}.${kid}.${mac}`;
      const unknown = `${until}.k${"0".repeat(16)}.${mac}`;
      const earlier = `${until}.${mac}`;
      for (const t of [flipped, later, unknown, earlier]) {
        browsers.set(t, browsers.get(fresh) as string);
        expect(status(await post(p, { ...wrong, form_token: t, password: PASSWORD }))).toBe(400);
      }
    },
    T,
  );

  it(
    "sets the form cookie the token is bound to: __Host-, Strict, HttpOnly, Secure",
    async () => {
      const page = await id().handle(
        request({ path: "/account/login", query: new Map([["return_to", TO]]) }),
      );
      expect(page?.kind === "page" && page.cookies).toContainEqual(
        expect.objectContaining({ name: FORM, path: "/", secure: true, sameSite: "Strict" }),
      );
    },
    T,
  );

  it(
    "refuses a token someone fetched for themselves, posted from another browser",
    async () => {
      const a = await account();
      const p = id();
      // The attacker fetches a form, and so holds a token and the form cookie bound to it.
      const theirs = await formToken(p, "203.0.113.9");
      // The victim's browser has a form cookie of its own, from a page it was shown.
      const victim = browsers.get(await formToken(p)) as string;
      const r = await post(
        p,
        { form_token: theirs, return_to: TO, name: a.name, password: PASSWORD },
        "198.51.100.7",
        { cookie: victim },
      );
      expect(status(r)).toBe(400);
      expect(loginCookie(r)).toBeUndefined();
    },
    T,
  );

  it(
    "refuses a token posted without the form cookie",
    async () => {
      const a = await account();
      const p = id();
      const r = await post(
        p,
        { form_token: await formToken(p), return_to: TO, name: a.name, password: PASSWORD },
        "198.51.100.7",
        { cookie: null },
      );
      expect(status(r)).toBe(400);
      expect(loginCookie(r)).toBeUndefined();
    },
    T,
  );

  it(
    "refuses a login posted from another origin, and takes one from its own",
    async () => {
      const a = await account();
      const p = id();
      const form = { return_to: TO, name: a.name, password: PASSWORD };
      for (const origin of ["https://evil.example", "null", "http://saveslot.example"]) {
        const r = await post(p, { ...form, form_token: await formToken(p) }, undefined, { origin });
        expect(status(r)).toBe(403);
        expect(loginCookie(r)).toBeUndefined();
      }
      const ok = await post(p, { ...form, form_token: await formToken(p) }, undefined, {
        origin: ORIGIN,
      });
      expect(ok).toMatchObject({ kind: "redirect", location: TO });
    },
    T,
  );

  it(
    "fails alike for a name without an account, a wrong password and a disabled account",
    async () => {
      const a = await account();
      const off = await account();
      await disableLocalUser(accounts, { name: off.name });
      const p = id();
      const pages = [
        await post(
          p,
          {
            form_token: await formToken(p, "203.0.113.1"),
            return_to: TO,
            name: "nobody-here",
            password: PASSWORD,
          },
          "203.0.113.1",
        ),
        await post(
          p,
          {
            form_token: await formToken(p, "203.0.113.2"),
            return_to: TO,
            name: a.name,
            password: "not the password",
          },
          "203.0.113.2",
        ),
        await post(
          p,
          {
            form_token: await formToken(p, "203.0.113.3"),
            return_to: TO,
            name: off.name,
            password: PASSWORD,
          },
          "203.0.113.3",
        ),
      ];
      const alerts = pages.map((x) =>
        x?.kind === "page" ? /role="alert">([^<]*)</.exec(x.html)?.[1] : x?.kind,
      );
      expect(pages.map(status)).toEqual([401, 401, 401]);
      expect(new Set(alerts).size).toBe(1);
    },
    T,
  );

  it(
    "refuses a logout posted from another origin, and takes one from its own or none",
    async () => {
      const p = id();
      const out = (origin?: string) =>
        p.handle(
          request({
            method: "POST",
            path: "/account/logout",
            headers: new Map(origin === undefined ? [] : [["origin", origin]]),
          }),
        );
      expect(status(await out("https://evil.example"))).toBe(403);
      expect(status(await out("null"))).toBe(403);
      expect(status(await out(ORIGIN))).toBe("redirect");
      expect(status(await out())).toBe("redirect");
    },
    T,
  );

  it(
    "compares Origin with its public origin in normal form: no trailing slash, no default port",
    async () => {
      const a = await account();
      const p = new LocalIdentity({
        accounts,
        loginMs: 60 * 60_000,
        origin: "https://saveslot.example:443/",
        formKeys: FORM_KEYS,
        now: () => clock,
      });
      const r = await post(
        p,
        { form_token: await formToken(p), return_to: TO, name: a.name, password: PASSWORD },
        undefined,
        { origin: "https://saveslot.example" },
      );
      expect(status(r)).toBe("redirect");
    },
    T,
  );

  it(
    "counts an attempt before its password is checked: 10 at once for one name, at most 5 checked",
    async () => {
      const a = await account();
      const p = id();
      const src = "192.0.2.30";
      const tokens = await Promise.all(Array.from({ length: 10 }, () => formToken(p, src)));
      const before = scryptLoadForTests().computations;
      const answers = await Promise.all(
        tokens.map((t) =>
          post(p, { form_token: t, return_to: TO, name: a.name, password: "wrong wrong" }, src),
        ),
      );
      expect(scryptLoadForTests().computations - before).toBeLessThanOrEqual(5);
      expect(answers.map(status).sort()).toEqual([
        401, 401, 401, 401, 401, 429, 429, 429, 429, 429,
      ]);
    },
    T,
  );

  it(
    "takes back the attempt of a right password: signing in uses up none of the five",
    async () => {
      const a = await account();
      const p = id();
      const src = "192.0.2.31";
      const attempt = async (password: string) =>
        status(
          await post(
            p,
            { form_token: await formToken(p, src), return_to: TO, name: a.name, password },
            src,
          ),
        );
      for (let i = 0; i < 4; i++) expect(await attempt("wrong wrong")).toBe(401);
      for (let i = 0; i < 3; i++) expect(await attempt(PASSWORD)).toBe("redirect");
      expect(await attempt("wrong wrong")).toBe(401);
      expect(await attempt(PASSWORD)).toBe(429);
    },
    T,
  );

  it(
    "counts an IPv6 source by its /64, and an IPv4-mapped one as IPv4",
    async () => {
      const a = await account();
      const p = id();
      for (let i = 1; i <= 5; i++) {
        const src = `2001:db8:1:2::${i.toString(16)}`;
        await post(
          p,
          {
            form_token: await formToken(p, src),
            return_to: TO,
            name: a.name,
            password: "wrong wrong",
          },
          src,
        );
      }
      const other = "2001:db8:1:2:ffff:ffff:ffff:ffff";
      expect(
        status(
          await post(
            p,
            {
              form_token: await formToken(p, other),
              return_to: TO,
              name: a.name,
              password: PASSWORD,
            },
            other,
          ),
        ),
      ).toBe(429);
      // Another /64 is another source.
      const elsewhere = "2001:db8:1:3::1";
      expect(
        status(
          await post(
            p,
            {
              form_token: await formToken(p, elsewhere),
              return_to: TO,
              name: a.name,
              password: PASSWORD,
            },
            elsewhere,
          ),
        ),
      ).toBe("redirect");
    },
    T,
  );

  it(
    `counts an IPv6 /48 too: after ${PER_WIDE_SOURCE} attempts from its /64s, another /64 of it is refused`,
    async () => {
      const a = await account();
      const p = id();
      for (let i = 0; i < PER_WIDE_SOURCE; i++) {
        const src = `2001:db8:9:${i.toString(16)}::1`;
        expect(
          status(
            await post(
              p,
              {
                form_token: await formToken(p, src),
                return_to: TO,
                name: a.name,
                password: "wrong wrong",
              },
              src,
            ),
          ),
        ).toBe(401);
      }
      const before = scryptLoadForTests().computations;
      const same = "2001:db8:9:ffff::1";
      expect(
        status(
          await post(
            p,
            {
              form_token: await formToken(p, same),
              return_to: TO,
              name: a.name,
              password: PASSWORD,
            },
            same,
          ),
        ),
      ).toBe(429);
      expect(scryptLoadForTests().computations).toBe(before);
      // Another /48 is not held back.
      const other = "2001:db8:a::1";
      expect(
        status(
          await post(
            p,
            {
              form_token: await formToken(p, other),
              return_to: TO,
              name: a.name,
              password: PASSWORD,
            },
            other,
          ),
        ),
      ).toBe("redirect");
    },
    T,
  );

  it(
    "takes back the /48's count of a right password too: signing in uses up none of its attempts",
    async () => {
      const a = await account();
      const p = id();
      let n = 0;
      // Each attempt from another /64 of one /48: only the /48's count adds up.
      const attempt = async (password: string) => {
        const src = `2001:db8:b:${(n++).toString(16)}::1`;
        return status(
          await post(
            p,
            { form_token: await formToken(p, src), return_to: TO, name: a.name, password },
            src,
          ),
        );
      };
      for (let i = 0; i < PER_WIDE_SOURCE - 1; i++) expect(await attempt("wrong wrong")).toBe(401);
      for (let i = 0; i < 3; i++) expect(await attempt(PASSWORD)).toBe("redirect");
      expect(await attempt("wrong wrong")).toBe(401);
      expect(await attempt(PASSWORD)).toBe(429);
    },
    T,
  );

  it(
    "with its count tables full of live counts, refuses a new source rather than drop another's count",
    async () => {
      const a = await account();
      const p = new LocalIdentity({
        accounts,
        loginMs: 60 * 60_000,
        origin: ORIGIN,
        formKeys: FORM_KEYS,
        now: () => clock,
        countCapForTests: 2,
      });
      const fail = (src: string) =>
        formToken(p, src).then((t) =>
          post(p, { form_token: t, return_to: TO, name: a.name, password: "wrong wrong" }, src),
        );
      expect(status(await fail("198.51.100.41"))).toBe(401);
      expect(status(await fail("198.51.100.42"))).toBe(401);
      // Full: a third source is refused, unchecked; the first two keep their counts.
      const before = scryptLoadForTests().computations;
      expect(status(await fail("198.51.100.43"))).toBe(429);
      expect(scryptLoadForTests().computations).toBe(before);
      expect(status(await fail("198.51.100.41"))).toBe(401);
      // Once those counts expire, there is room again.
      clock += 15 * 60_000;
      try {
        expect(status(await fail("198.51.100.43"))).toBe(401);
      } finally {
        clock -= 15 * 60_000;
      }
    },
    T,
  );

  it(
    "refuses at once, uncounted, an attempt that finds too many checks waiting",
    async () => {
      const a = await account();
      const p = id();
      const { acquire, release } = scryptPlacesForTests;
      await acquire();
      await acquire();
      const waiters = Array.from({ length: SCRYPT_WAIT_MAX }, () => acquire());
      try {
        const src = "192.0.2.40";
        // Raced with a timer: an attempt let in to wait would wait here for good.
        const r = await Promise.race([
          formToken(p, src).then((t) =>
            post(p, { form_token: t, return_to: TO, name: a.name, password: PASSWORD }, src),
          ),
          new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 5000)),
        ]);
        expect(r === "waited" ? "waited" : status(r)).toBe(503);
        expect(r !== "waited" && header(r, "retry-after")).toBe("1");
        expect(r !== "waited" && r?.kind === "page" && r.html).toContain(
          "Too many sign-ins at once.",
        );
      } finally {
        for (let i = 0; i < SCRYPT_WAIT_MAX + 2; i++) {
          release();
          await Promise.resolve();
        }
        await Promise.all(waiters);
        for (let i = 0; i < 10 && scryptLoadForTests().running > 0; i++) release();
      }
      // Not counted: the same source signs in five times after.
      for (let i = 0; i < 5; i++) {
        const src = "192.0.2.40";
        expect(
          status(
            await post(
              p,
              {
                form_token: await formToken(p, src),
                return_to: TO,
                name: a.name,
                password: "wrong wrong",
              },
              src,
            ),
          ),
        ).toBe(401);
      }
    },
    T,
  );

  it(
    "refuses, uncounted, an attempt that waited past the time limit for its turn",
    async () => {
      const a = await account();
      const p = id();
      const { acquire, release } = scryptPlacesForTests;
      useScryptWaitForTests(100);
      await acquire();
      await acquire();
      try {
        const src = "192.0.2.41";
        const t = await formToken(p, src);
        // Whether the limit has passed, by the clock the check's own wait runs on: a timer of the
        // same length, set before the request. Node fires timers of one length in the order they
        // were set, from the event loop's millisecond clock, which can be a millisecond behind
        // Date.now(): an elapsed time read from Date.now() could show 99.
        let limitPassed = false;
        const limit = new Promise<void>((resolve) =>
          setTimeout(() => {
            limitPassed = true;
            resolve();
          }, 100),
        );
        const r = await post(
          p,
          { form_token: t, return_to: TO, name: a.name, password: PASSWORD },
          src,
        );
        // Refused only after waiting the limit.
        expect(limitPassed).toBe(true);
        await limit;
        expect(status(r)).toBe(503);
        expect(header(r, "retry-after")).toBe("1");
        expect(scryptLoadForTests()).toMatchObject({ running: 2, waiting: 0 });
      } finally {
        useScryptWaitForTests(undefined);
        release();
        release();
      }
      expect(scryptLoadForTests()).toMatchObject({ running: 0, waiting: 0 });
      // Not counted: the same source signs in.
      const src = "192.0.2.41";
      expect(
        await post(
          p,
          { form_token: await formToken(p, src), return_to: TO, name: a.name, password: PASSWORD },
          src,
        ),
      ).toMatchObject({ kind: "redirect", location: TO });
    },
    T,
  );

  it(
    "gives the place a check gave up on to the next one waiting, and never times out the deployer's",
    async () => {
      expect(SCRYPT_WAIT_MS).toBe(2000);
      const { acquire, release } = scryptPlacesForTests;
      useScryptWaitForTests(50);
      await acquire();
      await acquire();
      try {
        const signIn = acquire(true).then(
          () => "got",
          (e) => (e instanceof PasswordChecksBusy ? "refused" : "other"),
        );
        let deployer = "waiting";
        const theirs = acquire().then(() => {
          deployer = "got";
        });
        expect(await signIn).toBe("refused");
        await new Promise((resolve) => setTimeout(resolve, 100));
        // The deployer's still waits, past the limit; the first place given up is its.
        expect(deployer).toBe("waiting");
        expect(scryptLoadForTests()).toMatchObject({ running: 2, waiting: 1 });
        release();
        await theirs;
        expect(deployer).toBe("got");
        expect(scryptLoadForTests()).toMatchObject({ running: 2, waiting: 0 });
      } finally {
        useScryptWaitForTests(undefined);
        for (let i = 0; i < 10 && scryptLoadForTests().running > 0; i++) release();
      }
    },
    T,
  );

  it(
    "with 100 sign-ins at once, refuses the ones over the cap at once and lets none it takes wait past the limit",
    async () => {
      const a = await account();
      const p = id();
      // Slower than the other cases' hashes, so that the queue fills; the limit shortened to match.
      const limit = 150;
      useScryptForTests({ N: 2 ** 14, r: 8, p: 1 });
      const hash = await hashPassword(PASSWORD);
      await db.write((tx) =>
        tx.query("UPDATE accounts SET password_hash = $2 WHERE id = $1", [a.user, hash]),
      );
      useScryptWaitForTests(limit);
      try {
        const srcs = Array.from(
          { length: 100 },
          (_, i) => `198.18.${Math.floor(i / 250)}.${(i % 250) + 1}`,
        );
        const tokens: string[] = [];
        for (const src of srcs) tokens.push(await formToken(p, src));
        const before = scryptLoadForTests();
        const results = await Promise.all(
          srcs.map(async (src, i) => {
            const started = Date.now();
            const r = await post(
              p,
              { form_token: tokens[i] as string, return_to: TO, name: a.name, password: PASSWORD },
              src,
            );
            return { r, ms: Date.now() - started };
          }),
        );
        const admitted = results.filter((x) => x.r?.kind === "redirect");
        const refused = results.filter((x) => status(x.r) === 503);
        expect(admitted.length + refused.length).toBe(100);
        for (const x of refused) expect(header(x.r, "retry-after")).toBe("1");
        // Told apart by the queue, not by the clock: some refused with the queue full, every
        // refusal either that or at the time limit.
        const after = scryptLoadForTests();
        const full = after.refusedFull - before.refusedFull;
        const late = after.refusedLate - before.refusedLate;
        expect(full).toBeGreaterThan(0);
        expect(full + late).toBe(refused.length);
        // A sign-in waits the limit at most, then its own computation and its write: bounded
        // generously, for a busy machine.
        expect(Math.max(...results.map((x) => x.ms))).toBeLessThan(limit + 10_000);
      } finally {
        useScryptWaitForTests(undefined);
        useScryptForTests({ N: 2 ** 10, r: 8, p: 1 });
      }
    },
    T,
  );

  it(
    "answers as a wrong password, and writes no login, when the password changed or the account was disabled after the check",
    async () => {
      for (const change of ["password", "disable"] as const) {
        const a = await account();
        let armed = true;
        // The change commits after the password was compared and before the login is written.
        const changing: ControlDb = {
          read: (fn) => db.read(fn),
          write: async (fn) => {
            if (armed) {
              armed = false;
              if (change === "password") {
                await setLocalPassword(accounts, {
                  name: a.name,
                  password: "another long one",
                  now: NOW,
                });
              } else {
                await disableLocalUser(accounts, { name: a.name });
              }
            }
            return db.write(fn);
          },
        };
        const p = over(changing);
        const r = await post(p, {
          form_token: await formToken(p),
          return_to: TO,
          name: a.name,
          password: PASSWORD,
        });
        expect([change, status(r), loginCookie(r)]).toEqual([change, 401, undefined]);
        expect(r?.kind === "page" && r.html).toContain("The name or password is not right");
        expect([change, await loginsOf(a.user)]).toEqual([change, 0]);
      }
    },
    T,
  );

  it(
    "refuses a return path outside printable ASCII as a bad request, and every redirect it gives fits in a header",
    async () => {
      const a = await account();
      const p = id();
      const bad = "/oauth/中";
      const got = await p.handle(
        request({ path: "/account/login", query: new Map([["return_to", bad]]) }),
      );
      expect(status(got)).toBe(400);
      expect(
        status(
          await post(p, {
            form_token: await formToken(p),
            return_to: bad,
            name: a.name,
            password: PASSWORD,
          }),
        ),
      ).toBe(400);
      expect(status(await p.beginLogin(request({}), bad))).toBe(400);
      // What a browser is sent to, as Node writes the header: no ERR_INVALID_CHAR.
      const begun = await p.beginLogin(request({}), TO);
      const signedIn = await post(p, {
        form_token: await formToken(p),
        return_to: TO,
        name: a.name,
        password: PASSWORD,
      });
      for (const r of [begun, signedIn]) {
        expect(r?.kind).toBe("redirect");
        expect(() =>
          validateHeaderValue("location", r?.kind === "redirect" ? r.location : ""),
        ).not.toThrow();
      }
    },
    T,
  );

  it(
    "refuses a name from a source after 5 failures in 15 minutes, and the source after 20",
    async () => {
      const a = await account();
      const p = id();
      const src = "192.0.2.10";
      for (let i = 0; i < 5; i++) {
        await post(
          p,
          {
            form_token: await formToken(p, src),
            return_to: TO,
            name: a.name,
            password: "wrong wrong",
          },
          src,
        );
      }
      expect(
        status(
          await post(
            p,
            {
              form_token: await formToken(p, src),
              return_to: TO,
              name: a.name,
              password: PASSWORD,
            },
            src,
          ),
        ),
      ).toBe(429);
      // Another source is not refused for that name.
      expect(
        await post(
          p,
          {
            form_token: await formToken(p, "192.0.2.11"),
            return_to: TO,
            name: a.name,
            password: PASSWORD,
          },
          "192.0.2.11",
        ),
      ).toMatchObject({ kind: "redirect" });
      // 20 failures from one source, over names, refuse the source.
      const many = "192.0.2.12";
      for (let i = 0; i < 20; i++) {
        await post(
          p,
          {
            form_token: await formToken(p, many),
            return_to: TO,
            name: `nobody${i}`,
            password: "wrong wrong",
          },
          many,
        );
      }
      expect(
        status(
          await post(
            p,
            {
              form_token: await formToken(p, many),
              return_to: TO,
              name: a.name,
              password: PASSWORD,
            },
            many,
          ),
        ),
      ).toBe(429);
      // After the window, the source may try again.
      clock += 15 * 60_000;
      expect(
        await post(
          p,
          { form_token: await formToken(p, many), return_to: TO, name: a.name, password: PASSWORD },
          many,
        ),
      ).toMatchObject({ kind: "redirect" });
    },
    T,
  );

  it(
    "names exactly the paths it answers",
    async () => {
      const p = id();
      // Every path it might answer, its own and others' near them: those `handle` answers, by any
      // method, must be `paths`, no more and no less.
      const candidates = [
        "/account/login",
        "/account/logout",
        "/account/",
        "/account/login/",
        "/account/loginx",
        "/oauth/token",
        "/oauth/authorize",
        "/oauth/identity/callback",
        "/",
      ];
      const answered = new Set<string>();
      for (const path of candidates) {
        for (const method of ["GET", "POST"]) {
          const r = await p.handle(
            request({ method, path, query: new Map([["return_to", TO]]), form: {} }),
          );
          if (r !== undefined) answered.add(path);
        }
      }
      expect([...p.paths].sort()).toEqual([...answered].sort());
      expect([...p.paths].sort()).toEqual(["/account/login", "/account/logout"]);
    },
    T,
  );

  it(
    "treats a cookie or a form field named __proto__ as a name like any other",
    async () => {
      const p = id();
      expect(
        await p.currentUser(request({ cookies: new Map([["__proto__", "x"]]) })),
      ).toBeUndefined();
      // Built as a map: an object literal's `__proto__` would set its prototype, not a field.
      const token = await formToken(p);
      const form = new Map([
        ["__proto__", "x"],
        ["form_token", token],
        ["return_to", TO],
        ["name", "nobody"],
        ["password", PASSWORD],
      ]);
      const cookies = new Map([
        ["__proto__", "x"],
        [FORM, browsers.get(token) as string],
      ]);
      const r = await p.handle({
        ...request({ method: "POST", path: "/account/login", cookies }),
        form,
      });
      expect(status(r)).toBe(401);
    },
    T,
  );

  it(
    "ends a login on logout, and when it expires",
    async () => {
      const a = await account();
      const p = id();
      const cookie = loginCookie(
        await post(p, {
          form_token: await formToken(p),
          return_to: TO,
          name: a.name,
          password: PASSWORD,
        }),
      ) as string;
      const req = request({ cookies: new Map([[LOGIN_COOKIE, cookie]]) });
      expect(await p.currentUser(req)).toBeDefined();
      clock += 60 * 60_000;
      expect(await p.currentUser(req)).toBeUndefined();
      clock -= 60 * 60_000;
      expect(await p.currentUser(req)).toBeDefined();
      await p.handle(
        request({
          method: "POST",
          path: "/account/logout",
          cookies: new Map([[LOGIN_COOKIE, cookie]]),
        }),
      );
      expect(await p.currentUser(req)).toBeUndefined();
    },
    T,
  );

  it(
    "does not take a login of an account while it is disabled, and takes it again once enabled",
    async () => {
      const a = await account();
      const p = id();
      const r = await post(p, {
        form_token: await formToken(p),
        return_to: TO,
        name: a.name,
        password: PASSWORD,
      });
      const req = request({ cookies: new Map([[LOGIN_COOKIE, loginCookie(r) as string]]) });
      expect((await p.currentUser(req))?.user).toBe(a.user);
      await disableLocalUser(accounts, { name: a.name });
      expect(await p.currentUser(req)).toBeUndefined();
      await enableLocalUser(accounts, { name: a.name });
      expect((await p.currentUser(req))?.user).toBe(a.user);
    },
    T,
  );

  it(
    "gives an account's state, unknown for a user it does not have",
    async () => {
      const a = await account();
      const p = id();
      expect(await p.userState(a.user)).toBe("active");
      await disableLocalUser(accounts, { name: a.name });
      expect(await p.userState(a.user)).toBe("disabled");
      expect(await p.userState(`u_${"0".repeat(26)}`)).toBe("unknown");
    },
    T,
  );
});

// A password change on a second connection while a login is being written on the first, its
// transaction stopped just before the insert with the account's row locked: the change waits, then
// ends the login. PGlite has one connection to a database, so the case runs on PostgreSQL only.
describe.runIf(TEST_BACKEND === "postgres")("a login written while the password changes", () => {
  it(
    "makes the change wait, and the change then ends it: no login outlives the password",
    async () => {
      const a = await account();
      let reached!: () => void;
      const atInsert = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pausing: ControlDb = {
        read: (fn) => db.read(fn),
        write: (fn) =>
          db.write((tx) =>
            fn({
              exec: (sql) => tx.exec(sql),
              query: async (sql, params) => {
                if (sql.includes("INSERT INTO web_logins")) {
                  reached();
                  await held;
                }
                return tx.query(sql, params);
              },
            }),
          ),
      };
      const second = await secondConnection(join(root, "control"));
      try {
        const p = over(pausing);
        const signing = post(p, {
          form_token: await formToken(p),
          return_to: TO,
          name: a.name,
          password: PASSWORD,
        });
        await atInsert;
        const changing = setLocalPassword(LocalAccounts.over(second), {
          name: a.name,
          password: "another long one",
          now: NOW,
        });
        const first = await Promise.race([
          changing.then(() => "changed"),
          new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
        ]);
        release();
        await signing;
        await changing;
        expect(first).toBe("waiting");
        expect(await loginsOf(a.user)).toBe(0);
      } finally {
        release();
        await second.close();
      }
    },
    T,
  );
});

const LATER = "2026-11-21T10:00:00.000Z";

/** An account with an active tenant (registered, its storage not made): what a session needs. */
async function owner(): Promise<{ name: string; user: `u_${string}` }> {
  const a = await account();
  const tenant = `tn_${randomCrockford(26)}` as TenantId;
  await cp.registerTenant({
    id: tenant,
    owner: a.user,
    ref: { kind: "postgres", cell: "cell_a", database: `db_${a.name}` },
  });
  await cp.activateTenant(tenant);
  return a;
}

/** A web login of the user's, as the page writes one: its ID. */
async function webLogin(user: string, expiresAt = LATER): Promise<string> {
  const login = `l_${randomCrockford(16)}`;
  await db.write((tx) =>
    tx.query(
      "INSERT INTO web_logins (id, cookie_hash, user_id, expires_at) VALUES ($1, $2, $3, $4)",
      [login, tokenHash(`sls_${randomCrockford(32)}`), user, expiresAt],
    ),
  );
  return login;
}

const issue = (user: string, login: string, p: LocalIdentity = id(), grant?: string) =>
  p.issueUserSession(user as `u_${string}`, {
    from: { login },
    expiresAt: LATER,
    now: NOW,
    ...(grant === undefined ? {} : { grant }),
  });

const refresh = (user: string, grantedAt: string, p: LocalIdentity = id()) =>
  p.issueUserSession(user as `u_${string}`, {
    from: { refresh: { grantedAt } },
    expiresAt: LATER,
    now: NOW,
  });

const sessionCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof UserSessionError) return e.code;
    throw e;
  }
  return "no error";
};

const sessionsOf = async (user: string) =>
  (
    await db.read((tx) =>
      tx.query("SELECT 1 FROM credentials WHERE kind = 'session' AND principal = $1", [user]),
    )
  ).rows.length;

describe("a user session issued by the local accounts", () => {
  it(
    "from the login the page made: recorded for the user's tenant, with its grant and expiry",
    async () => {
      const a = await owner();
      const p = id();
      const r = await post(p, {
        form_token: await formToken(p),
        return_to: TO,
        name: a.name,
        password: PASSWORD,
      });
      const who = await p.currentUser(
        request({ cookies: new Map([[LOGIN_COOKIE, loginCookie(r) as string]]) }),
      );
      const token = await issue(a.user, who?.session as string, p, "g_1");
      expect(await cp.credential(tokenHash(token))).toMatchObject({
        kind: "session",
        principal: a.user,
        expiresAt: LATER,
        grant: "g_1",
      });
      await expect(
        p.issueUserSession(a.user, { from: { assertion: true }, expiresAt: LATER, now: NOW }),
      ).rejects.toThrow("take no identity assertions");
      await expect(
        p.issueUserSession(a.user, {
          from: { login: who?.session as string },
          expiresAt: LATER,
          now: "2026-11-20T10:00:00Z",
        }),
      ).rejects.toThrow("an instant as toISOString writes it");
      expect(await sessionsOf(a.user)).toBe(1);
    },
    T,
  );

  it(
    "from no live login of the user's, for an account unknown, disabled (not now) or without a tenant, is not issued",
    async () => {
      const a = await owner();
      const other = await owner();
      const login = await webLogin(a.user);
      expect(await sessionCode(issue(a.user, "l_none"))).toBe("login_ended");
      expect(await sessionCode(issue(a.user, await webLogin(other.user)))).toBe("login_ended");
      expect(await sessionCode(issue(a.user, await webLogin(a.user, NOW)))).toBe("login_ended");
      expect(await sessionCode(issue(`u_${"0".repeat(26)}`, login))).toBe("login_ended");
      await disableLocalUser(accounts, { name: a.name });
      expect(await sessionCode(issue(a.user, login))).toBe("account_inactive");
      expect(await sessionCode(issue(a.user, "l_none"))).toBe("account_inactive");
      await enableLocalUser(accounts, { name: a.name });
      expect(await issue(a.user, login)).toMatch(/^sls_/);
      expect(await sessionsOf(a.user)).toBe(1);
      const tenantless = await account();
      expect(await sessionCode(issue(tenantless.user, await webLogin(tenantless.user)))).toBe(
        "unknown_user",
      );
    },
    T,
  );

  it(
    "from a login read before a password change and issued after it, is not issued",
    async () => {
      const a = await owner();
      // What `currentUser` gave, before the change.
      const login = await webLogin(a.user);
      await setLocalPassword(accounts, { name: a.name, password: "another long one", now: NOW });
      expect(await sessionCode(issue(a.user, login))).toBe("login_ended");
      expect(await sessionsOf(a.user)).toBe(0);
    },
    T,
  );

  it(
    "from a refresh: issued, until a password change at or after its grant; a later grant is issued",
    async () => {
      const a = await owner();
      const granted = "2026-11-19T10:00:00.000Z";
      expect(await refresh(a.user, granted)).toMatch(/^sls_/);
      expect(await sessionsOf(a.user)).toBe(1);
      await setLocalPassword(accounts, { name: a.name, password: "another long one", now: NOW });
      expect(await sessionCode(refresh(a.user, granted))).toBe("login_ended");
      expect(await sessionCode(refresh(a.user, NOW))).toBe("login_ended");
      expect(await refresh(a.user, "2026-11-20T10:00:00.001Z")).toMatch(/^sls_/);
      expect(await sessionCode(refresh(`u_${"0".repeat(26)}`, granted))).toBe("login_ended");
      await expect(refresh(a.user, "2026-11-19T10:00:00Z")).rejects.toThrow(
        "an instant as toISOString writes it",
      );
    },
    T,
  );

  it(
    "from a refresh while the account is disabled: not now; enabled again, issued",
    async () => {
      const a = await owner();
      const granted = "2026-11-19T10:00:00.000Z";
      await disableLocalUser(accounts, { name: a.name });
      expect(await sessionCode(refresh(a.user, granted))).toBe("account_inactive");
      await enableLocalUser(accounts, { name: a.name });
      expect(await refresh(a.user, granted)).toMatch(/^sls_/);
      expect(await sessionsOf(a.user)).toBe(1);
      // Disabled after a password change too: not now, and ended once enabled.
      await setLocalPassword(accounts, { name: a.name, password: "another long one", now: NOW });
      await disableLocalUser(accounts, { name: a.name });
      expect(await sessionCode(refresh(a.user, granted))).toBe("account_inactive");
      await enableLocalUser(accounts, { name: a.name });
      expect(await sessionCode(refresh(a.user, granted))).toBe("login_ended");
    },
    T,
  );
});

// A change on a second connection while a session is being issued on the first, its transaction
// stopped just before its insert with its locks taken: the account's row (which a password change
// and a disable take first) and then the login's (which a password change and a sign-out delete).
// The change waits for the session's transaction; a password change then ends the session with the
// login. PGlite has one connection to a database, so these run on PostgreSQL only.
describe.runIf(TEST_BACKEND === "postgres")("a session issued while the account changes", () => {
  /** Whether `change` was still waiting half a second in, and how many sessions the user has after. */
  async function whileIssuing(
    user: string,
    from: { login: string } | { refresh: { grantedAt: string } },
    change: (on: LocalAccounts, db: ControlDb) => Promise<void>,
  ): Promise<{ first: unknown; sessions: number }> {
    let reached!: () => void;
    const atInsert = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pausing: ControlDb = {
      read: (fn) => db.read(fn),
      write: (fn) =>
        db.write((tx) =>
          fn({
            exec: (sql) => tx.exec(sql),
            query: async (sql, params) => {
              if (sql.includes("INSERT INTO credentials")) {
                reached();
                await held;
              }
              return tx.query(sql, params);
            },
          }),
        ),
    };
    const second = await secondConnection(join(root, "control"));
    try {
      const issuing = over(pausing).issueUserSession(user as `u_${string}`, {
        from,
        expiresAt: LATER,
        now: NOW,
      });
      await atInsert;
      const changing = change(LocalAccounts.over(second), second);
      const first = await Promise.race([
        changing.then(() => "changed"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
      ]);
      release();
      await issuing;
      await changing;
      return { first, sessions: await sessionsOf(user) };
    } finally {
      release();
      await second.close();
    }
  }

  it(
    "makes a password change wait, and the change then ends it: no session outlives the password",
    async () => {
      const a = await owner();
      const got = await whileIssuing(a.user, { login: await webLogin(a.user) }, (on) =>
        setLocalPassword(on, { name: a.name, password: "another long one", now: NOW }),
      );
      expect(got).toEqual({ first: "waiting", sessions: 0 });
    },
    T,
  );

  it(
    "from a refresh, makes a password change wait, and the change then ends it",
    async () => {
      const a = await owner();
      const from = { refresh: { grantedAt: "2026-11-19T10:00:00.000Z" } };
      const got = await whileIssuing(a.user, from, (on) =>
        setLocalPassword(on, { name: a.name, password: "another long one", now: NOW }),
      );
      expect(got).toEqual({ first: "waiting", sessions: 0 });
    },
    T,
  );

  it(
    "makes a disable wait: the account's row is held",
    async () => {
      const a = await owner();
      const got = await whileIssuing(a.user, { login: await webLogin(a.user) }, (on) =>
        disableLocalUser(on, { name: a.name }),
      );
      expect(got).toEqual({ first: "waiting", sessions: 1 });
    },
    T,
  );

  it(
    "makes a sign-out wait: the login's row is held",
    async () => {
      const a = await owner();
      const login = await webLogin(a.user);
      const got = await whileIssuing(a.user, { login }, async (_, second) => {
        await second.write((tx) => tx.query("DELETE FROM web_logins WHERE id = $1", [login]));
      });
      expect(got).toEqual({ first: "waiting", sessions: 1 });
    },
    T,
  );
});
