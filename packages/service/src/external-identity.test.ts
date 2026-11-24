// The external login on either backend (02-architecture §5, §12): its tables made once; a login
// sent to the platform and back, its state this browser's (its cookie's secret) and used once; each way an assertion is
// refused, through the return; a `jti` used once, a restart included; an account first seen made a
// user with a tenant, two of its assertions at once included; new users counted per source; an
// account disabled and enabled; a user session issued from a live login or an assertion just taken,
// its locks taken in the order a disable keeps. Fictional accounts; the platform's side signs with
// fixed test keys.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  randomCrockford,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import type { TenantId, UserId } from "./control-plane.ts";
import {
  GOOD_HEADER,
  goodClaims,
  OTHER_KEY,
  signAssertion,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_KEY,
} from "./external-assertion.fixture.ts";
import {
  CALLBACK_PATH,
  disableExternalUser,
  ExternalIdentity,
  ExternalLoginError,
  ExternalLogins,
  enableExternalUser,
  initExternalLogin,
  LOGIN_MS,
  listExternalUsers,
  NEW_USERS_PER_SOURCE,
  NEW_USERS_PER_WIDE_SOURCE,
  openExternalLogin,
} from "./external-identity.ts";
import { type IdentityRequest, type IdentityResponse, UserSessionError } from "./identity.ts";
import {
  type ControlDb,
  initControlPlane,
  type ServerControlPlane,
} from "./server-control-plane.ts";

const T = 120_000;
const START = Date.parse("2026-11-20T10:00:00.000Z");
const CELL = "cell_a";
const LOGIN_URL = "https://platform.example/login?from=saveslot";
const TO = "/oauth/authorize?client_id=c";
const STATE = "__Host-saveslot_identity_state";
const LOGIN = "__Host-saveslot_identity_login";
const root = mkdtempSync(join(tmpdir(), "saveslot-external-identity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

const backend: StorageBackend = {
  open: (ref: TenantRef, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    return testBackend().open({ kind: "pglite", dir: join(root, ref.cell, ref.database) }, opts);
  },
};

let db: TenantStore;
let cp: ServerControlPlane;
let logins: ExternalLogins;
let clock = START;
const config = {
  issuer: TEST_ISSUER,
  loginUrl: LOGIN_URL,
  keys: [TEST_KEY.public],
  audience: TEST_AUDIENCE,
};
/**
 * A user's tenant registered and active in the control plane, its storage not made: what the
 * cases other than the two about making tenants need, at a fraction of the time.
 */
const registerOnly = async (owner: UserId) => {
  const id = `tn_${randomCrockford(26)}` as TenantId;
  const e = await cp.registerTenant({
    id,
    owner,
    ref: { kind: "postgres", cell: CELL, database: id.toLowerCase() },
  });
  await cp.activateTenant(e.id);
};

/** The provider; `real` makes tenants as the server does, storage and genesis included. */
const provider = (l: ExternalLogins = logins, real = false) =>
  new ExternalIdentity({
    logins: l,
    config,
    control: cp,
    backend,
    cell: CELL,
    cells: new Set([CELL]),
    now: () => clock,
    ...(real ? {} : { makeTenantForTests: registerOnly }),
  });

beforeAll(async () => {
  db = await testBackend().open({ kind: "pglite", dir: join(root, "control") }, { create: true });
  cp = await initControlPlane(db);
  logins = await initExternalLogin(db);
}, T);
afterAll(async () => {
  await db?.close();
}, T);

let accounts = 0;
const account = () => `acct_${++accounts}`;

function request(o: Partial<IdentityRequest>): IdentityRequest {
  return {
    method: "GET",
    path: "/",
    query: new Map(),
    headers: new Map(),
    cookies: new Map(),
    remote: "198.51.100.7",
    ...o,
  };
}

const status = (r: IdentityResponse | undefined) => (r?.kind === "page" ? r.status : r?.kind);
const cookieOf = (r: IdentityResponse | undefined, name: string) =>
  r?.cookies?.find((c) => c.name === name)?.value;

/** Each state's secret, as the cookie of the browser it was given to holds it. */
const secrets = new Map<string, string>();

/** A browser sent to sign in: the state the platform is given; its cookie's secret in `secrets`. */
async function begin(p: ExternalIdentity): Promise<string> {
  const r = await p.beginLogin(request({}), TO);
  if (r.kind !== "redirect") throw new Error("not sent to sign in");
  const state = new URL(r.location).searchParams.get("state");
  const secret = cookieOf(r, STATE);
  if (state === null || secret === undefined || secret === "") throw new Error("no state bound");
  secrets.set(state, secret);
  return state;
}

/** The platform's return to the server with `assertion`, from a browser holding `cookie` (by
 * default, the state's own secret). */
const callback = (
  p: ExternalIdentity,
  o: { readonly state: string; readonly assertion: string; readonly cookie?: string | null },
  remote = "198.51.100.7",
) =>
  p.handle(
    request({
      path: CALLBACK_PATH,
      query: new Map([
        ["state", o.state],
        ["assertion", o.assertion],
      ]),
      cookies: new Map(o.cookie === null ? [] : [[STATE, o.cookie ?? secrets.get(o.state) ?? ""]]),
      remote,
    }),
  );

const authorizeFor = (state: string, sub: string, edit = (c: Record<string, unknown>) => c) =>
  signAssertion(GOOD_HEADER, edit(goodClaims(clock, { purpose: "authorize", nonce: state, sub })));

const sessionFor = (sub: string, edit = (c: Record<string, unknown>) => c) =>
  signAssertion(GOOD_HEADER, edit(goodClaims(clock, { purpose: "session", sub })));

/** A full login of `sub`: its answer and the login cookie it set. */
async function signIn(p: ExternalIdentity, sub: string, remote = "198.51.100.7") {
  const state = await begin(p);
  const r = await callback(p, { state, assertion: authorizeFor(state, sub) }, remote);
  return { r, cookie: cookieOf(r, LOGIN) };
}

const current = (p: ExternalIdentity, cookie: string | undefined) =>
  p.currentUser(request({ cookies: new Map(cookie === undefined ? [] : [[LOGIN, cookie]]) }));

describe("the external login's tables", () => {
  it(
    "are made once; made again, their format is checked; not opened before they are made",
    async () => {
      await initExternalLogin(db);
      await openExternalLogin(db);
      // Each table whose expired rows a write deletes has an index on its expiry.
      const indexed = await db.read((tx) =>
        tx.query<{ tablename: string }>(
          `SELECT tablename FROM pg_indexes
             WHERE indexdef LIKE '%(expires_at)' ORDER BY tablename`,
        ),
      );
      expect(indexed.rows.map((r) => r.tablename)).toEqual([
        "external_jti",
        "external_logins",
        "external_states",
      ]);
      const dir = join(root, "fresh");
      const fresh = await testBackend().open({ kind: "pglite", dir }, { create: true });
      try {
        await expect(initExternalLogin(fresh)).rejects.toMatchObject({
          code: "external_not_initialized",
        });
        await initControlPlane(fresh);
        await expect(openExternalLogin(fresh)).rejects.toMatchObject({
          code: "external_not_initialized",
        });
        await initExternalLogin(fresh);
        await fresh.write((tx) =>
          tx.query("UPDATE control_meta SET value = '2' WHERE key = 'external_format'"),
        );
        await expect(openExternalLogin(fresh)).rejects.toMatchObject({
          code: "external_format_mismatch",
        });
      } finally {
        await fresh.close();
      }
    },
    T,
  );
});

// Two connections to one control database: the advisory lock is what makes one wait for the
// other's tables. PostgreSQL only: PGlite has one connection to a database.
describe.runIf(TEST_BACKEND === "postgres")("two connections to one control database", () => {
  it(
    "initializing the external login at the same time take turns, and both succeed",
    async () => {
      for (let round = 0; round < 5; round++) {
        const dir = join(root, `two-${round}`);
        const store = await testBackend().open({ kind: "pglite", dir }, { create: true });
        try {
          await initControlPlane(store);
          const [a, b] = await Promise.all([secondConnection(dir), secondConnection(dir)]);
          try {
            const results = await Promise.allSettled([initExternalLogin(a), initExternalLogin(b)]);
            expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
          } finally {
            await a.close();
            await b.close();
          }
        } finally {
          await store.close();
        }
      }
    },
    T,
  );
});

describe("the external login made", () => {
  it(
    "for a cell the deployment does not have is refused",
    async () => {
      expect(
        () =>
          new ExternalIdentity({
            logins,
            config,
            control: cp,
            backend,
            cell: "cell_elsewhere",
            cells: new Set([CELL]),
          }),
      ).toThrow(expect.objectContaining({ code: "unknown_cell" }));
    },
    T,
  );
});

describe("the paths it answers", () => {
  it(
    "are exactly the ones its handle answers",
    async () => {
      const p = provider();
      const candidates = [
        CALLBACK_PATH,
        "/oauth/identity/",
        "/oauth/identity/callback/",
        "/oauth/token",
        "/oauth/authorize",
        "/account/login",
        "/",
      ];
      const answered = new Set<string>();
      for (const path of candidates) {
        for (const method of ["GET", "POST"]) {
          if ((await p.handle(request({ method, path }))) !== undefined) answered.add(path);
        }
      }
      expect([...p.paths].sort()).toEqual([...answered].sort());
      expect([...p.paths]).toEqual([CALLBACK_PATH]);
    },
    T,
  );
});

describe("a login through the platform", () => {
  it(
    "sends the browser to the login address with the state only, bound to it by a __Host- cookie",
    async () => {
      const r = await provider().beginLogin(request({}), TO);
      expect(r.kind).toBe("redirect");
      const url = new URL(r.kind === "redirect" ? r.location : "");
      expect(`${url.origin}${url.pathname}`).toBe("https://platform.example/login");
      expect([...url.searchParams.keys()].sort()).toEqual(["from", "state"]);
      expect(r.cookies).toContainEqual(
        expect.objectContaining({ name: STATE, path: "/", secure: true, maxAgeSeconds: 600 }),
      );
      // The cookie holds a secret of its own, not the state the platform's addresses carry.
      const secret = cookieOf(r, STATE);
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(secret).not.toBe(url.searchParams.get("state"));
      expect(await provider().beginLogin(request({}), "https://evil.example/")).toMatchObject({
        kind: "page",
        status: 400,
      });
    },
    T,
  );

  it(
    "comes back signed in, to where it was going, with a referrer only to itself and nothing cached",
    async () => {
      const p = provider(logins, true);
      const sub = account();
      const state = await begin(p);
      const signedIn = clock;
      const r = await callback(p, {
        state,
        assertion: authorizeFor(state, sub, (c) => ({ ...c, name: "Ada <L>" })),
      });
      expect(r).toMatchObject({ kind: "redirect", location: TO });
      expect(r?.kind === "redirect" && r.headers).toContainEqual([
        "referrer-policy",
        "same-origin",
      ]);
      expect(r?.kind === "redirect" && r.headers).toContainEqual(["cache-control", "no-store"]);
      const who = await current(p, cookieOf(r, LOGIN));
      const users = await listExternalUsers(logins);
      const user = users.find((u) => u.subject === sub)?.user;
      expect(who).toMatchObject({
        user,
        name: "Ada <L>",
        expiresAt: new Date(signedIn + LOGIN_MS).toISOString(),
      });
      expect(who?.session).not.toBe(cookieOf(r, LOGIN));
      expect((await cp.tenantOf(user as `u_${string}`))?.state).toBe("active");
      // Without a name in the assertion, the account ID is shown.
      const again = await signIn(p, sub);
      expect((await current(p, again.cookie))?.name).toBe(sub);
      expect((await listExternalUsers(logins)).filter((u) => u.subject === sub)).toHaveLength(1);
    },
    T,
  );

  it(
    "refuses a state bound to another browser, or to none, and a state used already",
    async () => {
      const p = provider();
      const sub = account();
      const mine = await begin(p);
      const theirs = await begin(p);
      expect(
        status(
          await callback(p, {
            state: mine,
            assertion: authorizeFor(mine, sub),
            cookie: secrets.get(theirs) ?? "",
          }),
        ),
      ).toBe(400);
      const next = await begin(p);
      expect(
        status(
          await callback(p, { state: next, assertion: authorizeFor(next, sub), cookie: null }),
        ),
      ).toBe(400);
      const once = await begin(p);
      expect(status(await callback(p, { state: once, assertion: authorizeFor(once, sub) }))).toBe(
        "redirect",
      );
      expect(status(await callback(p, { state: once, assertion: authorizeFor(once, sub) }))).toBe(
        400,
      );
    },
    T,
  );

  it(
    "refuses the callback address alone: a browser without the state's secret is not signed in",
    async () => {
      const p = provider();
      const sub = account();
      const state = await begin(p);
      // Whoever holds the victim's full callback address (state and assertion) sets the cookie
      // they can: the state itself, or anything else but the secret.
      const assertion = authorizeFor(state, sub);
      for (const cookie of [state, createHash("sha256").update(state).digest("hex"), "x"]) {
        const r = await callback(p, { state, assertion, cookie });
        expect(status(r)).toBe(400);
        expect(cookieOf(r, LOGIN)).toBeUndefined();
      }
      // The state was taken by the first try: the address is no use afterwards, even with the secret.
      expect(status(await callback(p, { state, assertion }))).toBe(400);
      expect((await listExternalUsers(logins)).some((u) => u.subject === sub)).toBe(false);
    },
    T,
  );

  it(
    "refuses a state past its ten minutes",
    async () => {
      const p = provider();
      const state = await begin(p);
      clock += 10 * 60_000;
      try {
        expect(
          status(await callback(p, { state, assertion: authorizeFor(state, account()) })),
        ).toBe(400);
      } finally {
        clock -= 10 * 60_000;
      }
    },
    T,
  );

  it(
    "refuses each kind of bad assertion, making no user",
    async () => {
      const p = provider();
      const now = Math.floor(clock / 1000);
      const bad: [string, (state: string, sub: string) => string][] = [
        [
          "wrong signature",
          (s, sub) =>
            signAssertion(
              GOOD_HEADER,
              goodClaims(clock, { purpose: "authorize", nonce: s, sub }),
              OTHER_KEY,
            ),
        ],
        [
          "another alg",
          (s, sub) =>
            signAssertion(
              { ...GOOD_HEADER, alg: "HS256" },
              goodClaims(clock, { purpose: "authorize", nonce: s, sub }),
            ),
        ],
        [
          "unknown kid",
          (s, sub) =>
            signAssertion(
              { ...GOOD_HEADER, kid: "test-9" },
              goodClaims(clock, { purpose: "authorize", nonce: s, sub }),
            ),
        ],
        [
          "another issuer",
          (s, sub) => authorizeFor(s, sub, (c) => ({ ...c, iss: "https://evil.example" })),
        ],
        [
          "another audience",
          (s, sub) => authorizeFor(s, sub, (c) => ({ ...c, aud: "https://other.example" })),
        ],
        [
          "expired",
          (s, sub) => authorizeFor(s, sub, (c) => ({ ...c, iat: now - 90, exp: now - 1 })),
        ],
        [
          "valid too long",
          (s, sub) => authorizeFor(s, sub, (c) => ({ ...c, iat: now, exp: now + 300 })),
        ],
        [
          "issued ahead",
          (s, sub) => authorizeFor(s, sub, (c) => ({ ...c, iat: now + 60, exp: now + 90 })),
        ],
        ["account ID too long", (s) => authorizeFor(s, "a".repeat(129))],
        [
          "the session purpose",
          (s, sub) =>
            signAssertion(GOOD_HEADER, {
              ...goodClaims(clock, { purpose: "session", sub }),
              nonce: s,
            }),
        ],
        ["another login's state", (_s, sub) => authorizeFor("another state", sub)],
      ];
      for (const [what, make] of bad) {
        const sub = account();
        const state = await begin(p);
        const r = await callback(p, { state, assertion: make(state, sub) });
        expect([what, status(r)]).toEqual([what, 400]);
        expect(cookieOf(r, LOGIN)).toBeUndefined();
        expect((await listExternalUsers(logins)).some((u) => u.subject === sub)).toBe(false);
      }
    },
    T,
  );

  it(
    "takes an assertion's jti once, a restart included",
    async () => {
      const sub = account();
      const p = provider();
      const assertion = sessionFor(sub);
      expect(await p.acceptAssertion(assertion, "198.51.100.7")).toBeDefined();
      expect(await p.acceptAssertion(assertion, "198.51.100.7")).toBeUndefined();
      // Another process, or this one restarted: the jti is in the control database.
      const restarted = provider(await openExternalLogin(db));
      expect(await restarted.acceptAssertion(assertion, "198.51.100.7")).toBeUndefined();
      // The login's return refuses a jti used for a session too.
      const state = await begin(p);
      const jti = JSON.parse(Buffer.from(assertion.split(".")[1] as string, "base64url").toString())
        .jti as string;
      expect(
        status(
          await callback(p, { state, assertion: authorizeFor(state, sub, (c) => ({ ...c, jti })) }),
        ),
      ).toBe(400);
    },
    T,
  );

  it(
    "ends a login after its ten minutes",
    async () => {
      const p = provider();
      const { cookie } = await signIn(p, account());
      expect(await current(p, cookie)).toBeDefined();
      clock += 10 * 60_000;
      try {
        expect(await current(p, cookie)).toBeUndefined();
      } finally {
        clock -= 10 * 60_000;
      }
    },
    T,
  );
});

describe("an assertion for a session", () => {
  it(
    "gives the account's user and a session of its own; the login's assertion is refused there",
    async () => {
      const p = provider();
      const sub = account();
      const a = await p.acceptAssertion(sessionFor(sub), "198.51.100.7");
      const b = await p.acceptAssertion(sessionFor(sub), "198.51.100.7");
      expect(a?.user).toBe(b?.user);
      expect(a?.session).not.toBe(b?.session);
      expect((await cp.tenantOf(a?.user as `u_${string}`))?.state).toBe("active");
      expect(await p.acceptAssertion(authorizeFor("st", sub), "198.51.100.7")).toBeUndefined();
    },
    T,
  );

  it(
    "two at once for an account first seen make one user and one tenant",
    async () => {
      const p = provider(logins, true);
      const sub = account();
      const [a, b] = await Promise.all([
        p.acceptAssertion(sessionFor(sub), "198.51.100.8"),
        provider(logins, true).acceptAssertion(sessionFor(sub), "198.51.100.8"),
      ]);
      expect(a?.user).toBeDefined();
      expect(a?.user).toBe(b?.user);
      expect((await listExternalUsers(logins)).filter((u) => u.subject === sub)).toHaveLength(1);
      const tenant = await cp.tenantOf(a?.user as `u_${string}`);
      expect(tenant?.state).toBe("active");
    },
    T,
  );
});

describe("new users from one source", () => {
  it(
    `are at most ${NEW_USERS_PER_SOURCE} an hour; known accounts and other sources go on`,
    async () => {
      const p = provider();
      const source = "203.0.113.50";
      const made: string[] = [];
      for (let i = 0; i < NEW_USERS_PER_SOURCE; i++) {
        const sub = account();
        expect(await p.acceptAssertion(sessionFor(sub), source)).toBeDefined();
        made.push(sub);
      }
      const late = account();
      expect(await p.acceptAssertion(sessionFor(late), source)).toBeUndefined();
      const state = await begin(p);
      expect(
        status(await callback(p, { state, assertion: authorizeFor(state, late) }, source)),
      ).toBe(429);
      expect((await listExternalUsers(logins)).some((u) => u.subject === late)).toBe(false);
      // An account already known is no new user.
      expect(await p.acceptAssertion(sessionFor(made[0] as string), source)).toBeDefined();
      // An hour on, the source may bring new users again.
      clock += 60 * 60_000;
      try {
        expect(await p.acceptAssertion(sessionFor(late), source)).toBeDefined();
      } finally {
        clock -= 60 * 60_000;
      }
    },
    T,
  );
});

describe("new users counted per source", () => {
  it(
    "at once: ten assertions of accounts first seen, from one source, make at most five users",
    async () => {
      const p = provider();
      const source = "203.0.113.60";
      const subs = Array.from({ length: 10 }, () => account());
      const answers = await Promise.all(
        subs.map((sub) => p.acceptAssertion(sessionFor(sub), source)),
      );
      expect(answers.filter((x) => x !== undefined)).toHaveLength(NEW_USERS_PER_SOURCE);
      const known = new Set((await listExternalUsers(logins)).map((u) => u.subject));
      expect(subs.filter((sub) => known.has(sub))).toHaveLength(NEW_USERS_PER_SOURCE);
    },
    T,
  );

  it(
    "at once: several assertions of one account first seen count as one new user",
    async () => {
      const p = provider();
      const source = "203.0.113.61";
      const sub = account();
      const answers = await Promise.all(
        Array.from({ length: 4 }, () => p.acceptAssertion(sessionFor(sub), source)),
      );
      expect(new Set(answers.map((x) => x?.user)).size).toBe(1);
      // One of the five used: four more new users from that source, and no fifth.
      for (let i = 0; i < NEW_USERS_PER_SOURCE - 1; i++) {
        expect(await p.acceptAssertion(sessionFor(account()), source)).toBeDefined();
      }
      expect(await p.acceptAssertion(sessionFor(account()), source)).toBeUndefined();
    },
    T,
  );

  it(
    "with the count table full of live counts: a new source refused, the ones counted go on counting",
    async () => {
      const p = new ExternalIdentity({
        logins,
        config,
        control: cp,
        backend,
        cell: CELL,
        cells: new Set([CELL]),
        now: () => clock,
        makeTenantForTests: registerOnly,
        countCapForTests: 2,
      });
      expect(await p.acceptAssertion(sessionFor(account()), "198.51.100.71")).toBeDefined();
      expect(await p.acceptAssertion(sessionFor(account()), "198.51.100.72")).toBeDefined();
      const refused = account();
      expect(await p.acceptAssertion(sessionFor(refused), "198.51.100.73")).toBeUndefined();
      expect((await listExternalUsers(logins)).some((u) => u.subject === refused)).toBe(false);
      // A source already counted still brings new users, up to its limit.
      expect(await p.acceptAssertion(sessionFor(account()), "198.51.100.71")).toBeDefined();
      // Once the counts expire, there is room again.
      clock += 60 * 60_000;
      try {
        expect(await p.acceptAssertion(sessionFor(refused), "198.51.100.73")).toBeDefined();
      } finally {
        clock -= 60 * 60_000;
      }
    },
    T,
  );

  it(
    "count an IPv6 source by its /64",
    async () => {
      const p = provider();
      for (let i = 1; i <= NEW_USERS_PER_SOURCE; i++) {
        expect(await p.acceptAssertion(sessionFor(account()), `2001:db8:7:7::${i}`)).toBeDefined();
      }
      expect(
        await p.acceptAssertion(sessionFor(account()), "2001:db8:7:7:ffff::1"),
      ).toBeUndefined();
      expect(await p.acceptAssertion(sessionFor(account()), "2001:db8:7:8::1")).toBeDefined();
    },
    T,
  );

  it(
    `count an IPv6 /48 too: after ${NEW_USERS_PER_WIDE_SOURCE} from its /64s, another /64 of it is refused`,
    async () => {
      const p = provider();
      for (let i = 0; i < NEW_USERS_PER_WIDE_SOURCE; i++) {
        const src = `2001:db8:c:${i.toString(16)}::1`;
        expect(await p.acceptAssertion(sessionFor(account()), src)).toBeDefined();
      }
      const refused = account();
      expect(await p.acceptAssertion(sessionFor(refused), "2001:db8:c:ffff::1")).toBeUndefined();
      expect((await listExternalUsers(logins)).some((u) => u.subject === refused)).toBe(false);
      // Another /48 is not held back.
      expect(await p.acceptAssertion(sessionFor(refused), "2001:db8:d::1")).toBeDefined();
    },
    T,
  );

  it(
    "at once: several assertions of one account first seen, from /64s of one /48, use one of its count",
    async () => {
      const p = provider();
      const sub = account();
      const answers = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          p.acceptAssertion(sessionFor(sub), `2001:db8:e:${i.toString(16)}::1`),
        ),
      );
      expect(new Set(answers.map((x) => x?.user)).size).toBe(1);
      for (let i = 0; i < NEW_USERS_PER_WIDE_SOURCE - 1; i++) {
        const src = `2001:db8:e:${(0x100 + i).toString(16)}::1`;
        expect(await p.acceptAssertion(sessionFor(account()), src)).toBeDefined();
      }
      expect(await p.acceptAssertion(sessionFor(account()), "2001:db8:e:ffff::1")).toBeUndefined();
    },
    T,
  );
});

describe("an account disabled", () => {
  it(
    "has its login not taken and its assertions refused; enabled, both are back",
    async () => {
      const p = provider();
      const sub = account();
      const { cookie } = await signIn(p, sub);
      const user = (await current(p, cookie))?.user as `u_${string}`;
      expect(await p.userState(user)).toBe("active");
      await disableExternalUser(logins, { issuer: TEST_ISSUER, subject: sub });
      expect(await p.userState(user)).toBe("disabled");
      expect(await current(p, cookie)).toBeUndefined();
      expect(await p.acceptAssertion(sessionFor(sub), "198.51.100.7")).toBeUndefined();
      expect(status((await signIn(p, sub)).r)).toBe(400);
      await enableExternalUser(logins, { issuer: TEST_ISSUER, subject: sub });
      expect((await current(p, cookie))?.user).toBe(user);
      expect((await p.acceptAssertion(sessionFor(sub), "198.51.100.7"))?.user).toBe(user);
      await expect(
        disableExternalUser(logins, { issuer: TEST_ISSUER, subject: "acct_nobody" }),
      ).rejects.toBeInstanceOf(ExternalLoginError);
      expect(await p.userState(`u_${"0".repeat(26)}`)).toBe("unknown");
    },
    T,
  );
});

const iso = (ms: number) => new Date(ms).toISOString();
const LATER = "2026-11-21T10:00:00.000Z";

/** A user session from `from` at the provider's clock. */
type From = { login: string } | { assertion: true } | { refresh: { grantedAt: string } };
const issue = (p: ExternalIdentity, user: UserId, from: From) =>
  p.issueUserSession(user, { from, expiresAt: LATER, now: iso(clock), grant: "g_1" });

const sessionCode = async (q: Promise<unknown>) => {
  try {
    await q;
  } catch (e) {
    if (e instanceof UserSessionError) return e.code;
    throw e;
  }
  return "no error";
};

const sessionsOf = async (user: UserId) =>
  (
    await db.read((tx) =>
      tx.query("SELECT 1 FROM credentials WHERE kind = 'session' AND principal = $1", [user]),
    )
  ).rows.length;

/** A signed-in account: its user and the login's ID. */
async function signedIn(p: ExternalIdentity, sub: string) {
  const { cookie } = await signIn(p, sub);
  const who = await current(p, cookie);
  if (who === undefined) throw new Error("not signed in");
  return { user: who.user, login: who.session };
}

describe("a user session issued by the external login", () => {
  it(
    "from a live login of the user's, or an assertion just taken, for an active account",
    async () => {
      const p = provider();
      const sub = account();
      const { user, login } = await signedIn(p, sub);
      expect(await issue(p, user, { login })).toMatch(/^sls_/);
      const accepted = await p.acceptAssertion(sessionFor(sub), "198.51.100.7");
      expect(accepted?.user).toBe(user);
      expect(await issue(p, user, { assertion: true })).toMatch(/^sls_/);
      expect(await sessionsOf(user)).toBe(2);
      const other = await signedIn(p, account());
      expect(await sessionCode(issue(p, user, { login: other.login }))).toBe("login_ended");
      expect(await sessionCode(issue(p, user, { login: "nothing" }))).toBe("login_ended");
      expect(
        await sessionCode(issue(p, `u_${"0".repeat(26)}` as UserId, { assertion: true })),
      ).toBe("login_ended");
      await expect(
        p.issueUserSession(user, { from: { login }, expiresAt: LATER, now: "yesterday" }),
      ).rejects.toThrow("an instant as toISOString writes it");
    },
    T,
  );

  it(
    "not from a login that has expired, and not now for an account disabled, either way",
    async () => {
      const p = provider();
      const sub = account();
      const { user, login } = await signedIn(p, sub);
      clock += 10 * 60_000;
      try {
        expect(await sessionCode(issue(p, user, { login }))).toBe("login_ended");
      } finally {
        clock -= 10 * 60_000;
      }
      await disableExternalUser(logins, { issuer: TEST_ISSUER, subject: sub });
      expect(await sessionCode(issue(p, user, { login }))).toBe("account_inactive");
      expect(await sessionCode(issue(p, user, { assertion: true }))).toBe("account_inactive");
      expect(await sessionCode(issue(p, user, { login: "nothing" }))).toBe("account_inactive");
      await enableExternalUser(logins, { issuer: TEST_ISSUER, subject: sub });
      expect(await issue(p, user, { login })).toMatch(/^sls_/);
      expect(await sessionsOf(user)).toBe(1);
    },
    T,
  );

  it(
    "from a refresh: issued; not now while the account is disabled; enabled again, issued",
    async () => {
      const p = provider();
      const sub = account();
      const { user } = await signedIn(p, sub);
      const granted = { refresh: { grantedAt: iso(clock - 60_000) } };
      expect(await issue(p, user, granted)).toMatch(/^sls_/);
      await disableExternalUser(logins, { issuer: TEST_ISSUER, subject: sub });
      expect(await sessionCode(issue(p, user, granted))).toBe("account_inactive");
      await enableExternalUser(logins, { issuer: TEST_ISSUER, subject: sub });
      expect(await issue(p, user, granted)).toMatch(/^sls_/);
      expect(await sessionsOf(user)).toBe(2);
      expect(await sessionCode(issue(p, `u_${"0".repeat(26)}` as UserId, granted))).toBe(
        "login_ended",
      );
      await expect(issue(p, user, { refresh: { grantedAt: "yesterday" } })).rejects.toThrow(
        "an instant as toISOString writes it",
      );
    },
    T,
  );
});

// A change on a second connection while a session is being issued on the first, its transaction
// stopped just before its insert with its locks taken: the account's row (which a disable takes)
// and then the login's. The change waits for the session's transaction. PostgreSQL only: PGlite has
// one connection to a database.
describe.runIf(TEST_BACKEND === "postgres")("a session issued while the account changes", () => {
  /** Whether `change` was still waiting half a second in. */
  async function whileIssuing(
    user: UserId,
    from: From,
    change: (second: ControlDb) => Promise<unknown>,
  ): Promise<unknown> {
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
      const issuing = issue(provider(ExternalLogins.over(pausing)), user, from);
      await atInsert;
      const changing = change(second);
      const first = await Promise.race([
        changing.then(() => "changed"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 500)),
      ]);
      release();
      await issuing;
      await changing;
      return first;
    } finally {
      release();
      await second.close();
    }
  }

  const disable = (sub: string) => (second: ControlDb) =>
    second.write((tx) =>
      tx.query("UPDATE external_users SET state = 'disabled' WHERE issuer = $1 AND subject = $2", [
        TEST_ISSUER,
        sub,
      ]),
    );

  it(
    "makes a disable wait, from a login or from an assertion: the account's row is held",
    async () => {
      const p = provider();
      const sub = account();
      const { user, login } = await signedIn(p, sub);
      expect(await whileIssuing(user, { login }, disable(sub))).toBe("waiting");
      const again = account();
      const { user: other } = await signedIn(p, again);
      expect(await whileIssuing(other, { assertion: true }, disable(again))).toBe("waiting");
    },
    T,
  );

  it(
    "from a refresh, makes a disable wait; then not now, until enabled again",
    async () => {
      const p = provider();
      const sub = account();
      const { user } = await signedIn(p, sub);
      const from = { refresh: { grantedAt: iso(clock - 60_000) } };
      expect(await whileIssuing(user, from, disable(sub))).toBe("waiting");
      expect(await sessionCode(issue(p, user, from))).toBe("account_inactive");
      await enableExternalUser(logins, { issuer: TEST_ISSUER, subject: sub });
      expect(await issue(p, user, from)).toMatch(/^sls_/);
    },
    T,
  );

  it(
    "makes a removal of the login wait: the login's row is held",
    async () => {
      const p = provider();
      const { user, login } = await signedIn(p, account());
      const removing = (second: ControlDb) =>
        second.write((tx) => tx.query("DELETE FROM external_logins WHERE id = $1", [login]));
      expect(await whileIssuing(user, { login }, removing)).toBe("waiting");
    },
    T,
  );
});
