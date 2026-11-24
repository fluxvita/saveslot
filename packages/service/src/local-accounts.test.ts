// The local accounts on either backend (02-architecture §5, §9, §12): their tables made once and
// opened only once made; passwords hashed with their parameters kept, a stored hash read strictly,
// two computations at a time, a name without an account checked all the same; an account made with
// its tenant, finished after a stop, never twice at once; a password changed ending the user's
// sessions only; an account disabled and enabled; a user session written for a user with an active
// tenant. Fictional names.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  randomCrockford,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import { secondConnection } from "../../test-backend/src/second-connection.fixture.ts";
import type { TenantId, UserId } from "./control-plane.ts";
import { UserSessionError, writeUserSession } from "./identity.ts";
import {
  addLocalUser,
  disableLocalUser,
  enableLocalUser,
  initLocalAccounts,
  type LocalAccounts,
  LocalAccountsError,
  listLocalUsers,
  openLocalAccounts,
  setLocalPassword,
} from "./local-accounts.ts";
import {
  dummyHash,
  hashPassword,
  lockAccountForSession,
  lockActiveAccount,
  passwordMatches,
  resetDummyForTests,
  SCRYPT,
  SCRYPT_AT_ONCE,
  SCRYPT_WAIT_MS,
  STORED_MAX,
  scryptLoadForTests,
  scryptPlacesForTests,
  useScryptForTests,
  verifyLocalPassword,
} from "./local-passwords.ts";
import { initControlPlane, type ServerControlPlane } from "./server-control-plane.ts";
import { ServerTenantError } from "./server-tenant.ts";
import { newToken, tokenHash } from "./tokens.ts";

const T = 120_000;
const NOW = "2026-11-20T10:00:00.000Z";
const CELL = "cell_a";
const root = mkdtempSync(join(tmpdir(), "saveslot-local-accounts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

const backend: StorageBackend = {
  open: (ref: TenantRef, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    return testBackend().open({ kind: "pglite", dir: join(root, ref.cell, ref.database) }, opts);
  },
};

let db: TenantStore;
let cp: ServerControlPlane;
let accounts: LocalAccounts;
beforeAll(async () => {
  // Cheap parameters for every hash but those of "passwords", which pin the real ones.
  useScryptForTests({ N: 2 ** 10, r: 8, p: 1 });
  db = await testBackend().open({ kind: "pglite", dir: join(root, "control") }, { create: true });
  cp = await initControlPlane(db);
  accounts = await initLocalAccounts(db);
}, T);
afterAll(async () => {
  await db?.close();
}, T);

let names = 0;
const name = () => `person${++names}`;
const PASSWORD = "correct horse battery";
/**
 * An account whose tenant is registered and active, without its storage made: what the operations
 * other than `addLocalUser` need, at a fraction of the time a tenant's storage takes to make.
 */
async function registered(n: string): Promise<{ user: UserId; tenant: TenantId }> {
  const user = `u_${randomCrockford(26)}` as UserId;
  const tenant = `tn_${randomCrockford(26)}` as TenantId;
  const hash = await hashPassword(PASSWORD);
  await db.write((tx) =>
    tx.query(
      "INSERT INTO accounts (id, name, password_hash, state) VALUES ($1, $2, $3, 'active')",
      [user, n, hash],
    ),
  );
  await cp.registerTenant({
    id: tenant,
    owner: user,
    ref: { kind: "postgres", cell: CELL, database: `db_${n}` },
  });
  await cp.activateTenant(tenant);
  return { user, tenant };
}

const add = (n: string, password = PASSWORD) =>
  addLocalUser(accounts, {
    control: cp,
    backend,
    name: n,
    password,
    cell: CELL,
    cells: new Set([CELL]),
    now: NOW,
  });

const LATER = "2026-11-21T10:00:00.000Z";

/** A user session written for the user, as a provider writes one once it holds its locks. */
const session = (user: UserId, grant?: string) =>
  db.write((tx) =>
    writeUserSession(tx, user, { expiresAt: LATER, ...(grant === undefined ? {} : { grant }) }),
  );

const sessionsOf = async (user: UserId) =>
  (
    await db.read((tx) =>
      tx.query("SELECT 1 FROM credentials WHERE kind = 'session' AND principal = $1", [user]),
    )
  ).rows.length;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof LocalAccountsError) return e.code;
    throw e;
  }
  return "no error";
};

describe("the local accounts' tables", () => {
  it(
    "are made once; made again, their format is checked and nothing changes",
    async () => {
      const n = name();
      await registered(n);
      await initLocalAccounts(db);
      await openLocalAccounts(db);
      expect((await listLocalUsers(accounts)).some((u) => u.name === n)).toBe(true);
      await db.write((tx) =>
        tx.query("UPDATE control_meta SET value = '2' WHERE key = 'accounts_format'"),
      );
      expect(await code(initLocalAccounts(db))).toBe("accounts_format_mismatch");
      expect(await code(openLocalAccounts(db))).toBe("accounts_format_mismatch");
      await db.write((tx) =>
        tx.query("UPDATE control_meta SET value = '1' WHERE key = 'accounts_format'"),
      );
    },
    T,
  );

  it(
    "are not opened before they are made, nor made before the control plane's",
    async () => {
      const dir = join(root, "fresh");
      const fresh = await testBackend().open({ kind: "pglite", dir }, { create: true });
      try {
        expect(await code(initLocalAccounts(fresh))).toBe("accounts_not_initialized");
        await initControlPlane(fresh);
        expect(await code(openLocalAccounts(fresh))).toBe("accounts_not_initialized");
        await initLocalAccounts(fresh);
        await openLocalAccounts(fresh);
        // The format recorded and a table gone: not opened either.
        await fresh.write((tx) => tx.exec("DROP TABLE web_logins"));
        expect(await code(openLocalAccounts(fresh))).toBe("accounts_not_initialized");
      } finally {
        await fresh.close();
      }
    },
    T,
  );
});

// Two connections to one control database (two processes starting at once): the advisory lock is
// what makes one wait for the other's tables. PGlite has one connection to a database, so the case
// runs on PostgreSQL only.
describe.runIf(TEST_BACKEND === "postgres")("two connections to one control database", () => {
  it(
    "initializing the accounts at the same time take turns, and both succeed",
    async () => {
      for (let round = 0; round < 5; round++) {
        const dir = join(root, `two-${round}`);
        const store = await testBackend().open({ kind: "pglite", dir }, { create: true });
        try {
          await initControlPlane(store);
          const [a, b] = await Promise.all([secondConnection(dir), secondConnection(dir)]);
          try {
            const results = await Promise.allSettled([initLocalAccounts(a), initLocalAccounts(b)]);
            expect(results).toEqual([
              { status: "fulfilled", value: expect.anything() },
              { status: "fulfilled", value: expect.anything() },
            ]);
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

describe("passwords", () => {
  it(
    "are kept with their parameters, the real ones, and checked with the parameters kept",
    async () => {
      useScryptForTests(undefined);
      try {
        const h = await hashPassword(PASSWORD);
        expect(h).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
        expect(await passwordMatches(PASSWORD, h)).toBe(true);
        expect(await passwordMatches("correct horse batteryX", h)).toBe(false);
        expect(await passwordMatches(PASSWORD, "not a hash")).toBe(false);
        // A hash made with other parameters is checked with those.
        const cheaper = h.replace("scrypt$32768$", "scrypt$16384$");
        expect(await passwordMatches(PASSWORD, cheaper)).toBe(false);
        // The real parameters are within what a stored hash may name.
        expect(SCRYPT.N).toBeLessThanOrEqual(STORED_MAX.N);
        expect(SCRYPT.r).toBeLessThanOrEqual(STORED_MAX.r);
        expect(SCRYPT.p).toBeLessThanOrEqual(STORED_MAX.p);
      } finally {
        useScryptForTests({ N: 2 ** 10, r: 8, p: 1 });
      }
    },
    T,
  );

  it(
    "are worked out two at a time, a name's dummy check queued with the rest",
    async () => {
      expect(SCRYPT_AT_ONCE).toBe(2);
      const dummy = await dummyHash();
      expect(scryptLoadForTests()).toMatchObject({ running: 0, waiting: 0 });
      // Each call starts its computation before it first waits: right after the three calls, two
      // run and the third, the dummy check, waits its turn.
      const all = [
        hashPassword("first password"),
        hashPassword("second password"),
        passwordMatches("a guess at nothing", dummy),
      ];
      expect(scryptLoadForTests()).toMatchObject({ running: 2, waiting: 1 });
      await Promise.all(all);
      expect(scryptLoadForTests()).toMatchObject({ running: 0, waiting: 0 });
    },
    T,
  );

  it(
    "never run more than two at once: a place given up goes to the one waiting, not to one arriving in between",
    async () => {
      const { acquire, release } = scryptPlacesForTests;
      try {
        await acquire();
        await acquire();
        const c = acquire();
        expect(scryptLoadForTests()).toMatchObject({ running: 2, waiting: 1 });
        // One place given up, and in the same moment another computation arrives: the place is
        // the waiting one's, and the newcomer waits.
        release();
        const d = acquire();
        await c;
        expect(scryptLoadForTests()).toMatchObject({ running: 2, waiting: 1 });
        expect(scryptLoadForTests().peak).toBeLessThanOrEqual(2);
        release();
        await d;
        release();
        release();
        expect(scryptLoadForTests()).toMatchObject({ running: 0, waiting: 0 });
      } finally {
        // Whatever failed, every place is given back, so that the tests after this one can compute.
        for (
          let i = 0;
          i < 10 && scryptLoadForTests().running + scryptLoadForTests().waiting > 0;
          i++
        ) {
          release();
          await Promise.resolve();
        }
      }
    },
    T,
  );

  it(
    "a time limit that runs out once its wait was over takes nobody else out of the queue",
    async () => {
      const { acquire, release } = scryptPlacesForTests;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // Its turn clears the time limit; here it is not cleared, so that it runs out anyway.
      const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
      try {
        await acquire();
        await acquire();
        const a = acquire(true);
        release();
        await a;
        vi.advanceTimersByTime(SCRYPT_WAIT_MS / 2);
        const b = acquire(true);
        expect(scryptLoadForTests()).toMatchObject({ running: 2, waiting: 1 });
        // The first one's time limit runs out: the second is still waiting, and gets the next place.
        vi.advanceTimersByTime(SCRYPT_WAIT_MS / 2);
        expect(scryptLoadForTests()).toMatchObject({ running: 2, waiting: 1 });
        release();
        await b;
        release();
        release();
        expect(scryptLoadForTests()).toMatchObject({ running: 0, waiting: 0 });
      } finally {
        clear.mockRestore();
        vi.useRealTimers();
        for (
          let i = 0;
          i < 10 && scryptLoadForTests().running + scryptLoadForTests().waiting > 0;
          i++
        ) {
          release();
          await Promise.resolve();
        }
      }
    },
    T,
  );

  it(
    "match nothing when stored outside what this writes: a key not of 32 bytes, a short salt, parameters out of bounds",
    async () => {
      const good = await hashPassword(PASSWORD);
      const [, N, r, p, salt, key] = good.split("$") as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const started = scryptLoadForTests().computations;
      for (const stored of [
        `scrypt$${N}$${r}$${p}$${salt}$_`,
        `scrypt$${N}$${r}$${p}$${salt}$`,
        `scrypt$${N}$${r}$${p}$${salt}$${key.slice(0, 20)}`,
        `scrypt$${N}$${r}$${p}$AAAA$${key}`,
        `scrypt$${2 ** 20}$${r}$${p}$${salt}$${key}`,
        `scrypt$1000$${r}$${p}$${salt}$${key}`,
        `scrypt$${N}$17$${p}$${salt}$${key}`,
        `scrypt$${N}$0$${p}$${salt}$${key}`,
        `scrypt$${N}$${r}$17$${salt}$${key}`,
        `scrypt$${N}$${r}$5$${salt}$${key}`,
        `scrypt$${N}$${r}$0$${salt}$${key}`,
        "not a hash",
      ]) {
        expect([stored, await passwordMatches(PASSWORD, stored)]).toEqual([stored, false]);
      }
      // None of them was worth a computation.
      expect(scryptLoadForTests().computations).toBe(started);
      expect(await passwordMatches(PASSWORD, good)).toBe(true);
    },
    T,
  );

  it(
    "each get a salt of their own",
    async () => {
      const a = await hashPassword(PASSWORD);
      const b = await hashPassword(PASSWORD);
      expect(a.split("$")[4]).not.toBe(b.split("$")[4]);
      expect(a).not.toBe(b);
    },
    T,
  );

  it(
    "with p up to 4 match, and are not made with parameters a stored hash may not name",
    async () => {
      try {
        useScryptForTests({ N: 2 ** 10, r: 8, p: 4 });
        expect(await passwordMatches(PASSWORD, await hashPassword(PASSWORD))).toBe(true);
        useScryptForTests({ N: 2 ** 10, r: 8, p: 5 });
        await expect(hashPassword(PASSWORD)).rejects.toThrow("outside what a stored hash may name");
      } finally {
        useScryptForTests({ N: 2 ** 10, r: 8, p: 1 });
      }
    },
    T,
  );

  it(
    "have their dummy made when the accounts are opened: the first name without an account costs one computation",
    async () => {
      resetDummyForTests();
      const before = scryptLoadForTests().computations;
      const opened = await openLocalAccounts(db);
      expect(scryptLoadForTests().computations - before).toBe(1);
      const checked = scryptLoadForTests().computations;
      expect(await verifyLocalPassword(opened.db, "nobody-at-all", PASSWORD)).toBeUndefined();
      expect(scryptLoadForTests().computations - checked).toBe(1);
    },
    T,
  );

  it(
    "give the stored hash they were compared with, with the account",
    async () => {
      const n = name();
      const r = await registered(n);
      const stored = await db.read((tx) =>
        tx.query<{ password_hash: string }>("SELECT password_hash FROM accounts WHERE id = $1", [
          r.user,
        ]),
      );
      expect(await verifyLocalPassword(accounts.db, n, PASSWORD)).toEqual({
        user: r.user,
        name: n,
        passwordHash: stored.rows[0]?.password_hash,
      });
    },
    T,
  );

  it(
    "records when a password change ended its sessions, never moved back; a disable and an enable do not; its standing for a session",
    async () => {
      const n = name();
      const r = await registered(n);
      const ended = async (at: string) =>
        (await db.write((tx) => lockAccountForSession(tx, r.user, at))) === "ended";
      const T1 = "2026-11-20T11:00:00.000Z";
      const T2 = "2026-11-20T12:00:00.000Z";
      const after = (t: string) => new Date(Date.parse(t) + 1).toISOString();
      expect(await ended(NOW)).toBe(false);
      await setLocalPassword(accounts, { name: n, password: "another long one", now: T1 });
      expect(await ended(T1)).toBe(true);
      expect(await ended(NOW)).toBe(true);
      expect(await ended(after(T1))).toBe(false);
      await disableLocalUser(accounts, { name: n });
      expect(await db.write((tx) => lockAccountForSession(tx, r.user, after(T1)))).toBe("inactive");
      expect(await db.write((tx) => lockAccountForSession(tx, r.user, T1))).toBe("inactive");
      await enableLocalUser(accounts, { name: n });
      expect(await ended(after(T1))).toBe(false);
      expect(await db.write((tx) => lockAccountForSession(tx, r.user))).toBe("active");
      expect(
        await db.write((tx) => lockAccountForSession(tx, `u_${"0".repeat(26)}` as UserId, T1)),
      ).toBe("unknown");
      await setLocalPassword(accounts, { name: n, password: "a third long one", now: T2 });
      expect(await ended(T2)).toBe(true);
      // A clock moved back moves nothing back.
      await setLocalPassword(accounts, { name: n, password: "a fourth long one", now: T1 });
      expect(await ended(T2)).toBe(true);
      await expect(
        setLocalPassword(accounts, { name: n, password: PASSWORD, now: "2026-11-20T10:00:00Z" }),
      ).rejects.toThrow("an instant as toISOString writes it");
    },
    T,
  );

  it(
    "re-checked in a transaction: the account active and, when given, still with the hash compared",
    async () => {
      const n = name();
      const r = await registered(n);
      const compared = (await verifyLocalPassword(accounts.db, n, PASSWORD))
        ?.passwordHash as string;
      const check = (hash?: string, user: UserId = r.user) =>
        db.write((tx) => lockActiveAccount(tx, user, hash));
      expect(await check(compared)).toBe(true);
      expect(await check()).toBe(true);
      expect(await check(`${compared}x`)).toBe(false);
      expect(await check(compared, `u_${"0".repeat(26)}` as UserId)).toBe(false);
      await disableLocalUser(accounts, { name: n });
      expect(await check(compared)).toBe(false);
      expect(await check()).toBe(false);
      await enableLocalUser(accounts, { name: n });
      await setLocalPassword(accounts, { name: n, password: "another long one", now: NOW });
      expect(await check(compared)).toBe(false);
      expect(await check()).toBe(true);
    },
    T,
  );

  it(
    "for a name without an account, or one no account can have, are checked all the same",
    async () => {
      await dummyHash();
      // The reads it makes: a name no account can have, or a password too long, is not looked up.
      let reads = 0;
      const counted = {
        read: <R>(fn: Parameters<typeof accounts.db.read<R>>[0]) => {
          reads++;
          return accounts.db.read(fn);
        },
        write: accounts.db.write.bind(accounts.db),
      } as typeof accounts.db;
      for (const [n, password, lookups] of [
        ["nobody-at-all", PASSWORD, 1],
        ["Robin", PASSWORD, 0],
        ["a\u0000b", PASSWORD, 0],
        ["nobody-at-all", "p".repeat(2000), 0],
      ] as const) {
        const before = scryptLoadForTests().computations;
        reads = 0;
        expect(await verifyLocalPassword(counted, n, password)).toBeUndefined();
        expect([n, scryptLoadForTests().computations - before, reads]).toEqual([n, 1, lookups]);
      }
    },
    T,
  );

  it(
    "for a name without an account answer as for one with, after the dummy hash failed once",
    async () => {
      const r = await registered(name());
      const n = (await listLocalUsers(accounts)).find((u) => u.user === r.user)?.name as string;
      resetDummyForTests();
      useScryptForTests({ N: 3, r: 8, p: 1 });
      await expect(verifyLocalPassword(accounts.db, "nobody-at-all", PASSWORD)).rejects.toThrow();
      useScryptForTests({ N: 2 ** 10, r: 8, p: 1 });
      // Made again, not kept failed: a name without an account answers, as one with does.
      expect(await verifyLocalPassword(accounts.db, "nobody-at-all", PASSWORD)).toBeUndefined();
      expect((await verifyLocalPassword(accounts.db, n, PASSWORD))?.user).toBe(r.user);
    },
    T,
  );
});

describe("an account", () => {
  it(
    "is made with its active tenant, and its name is then taken",
    async () => {
      const n = name();
      const r = await add(n);
      expect((await cp.tenantOf(r.user))?.state).toBe("active");
      expect((await cp.tenantOf(r.user))?.id).toBe(r.tenant);
      expect(await listLocalUsers(accounts)).toContainEqual({
        user: r.user,
        name: n,
        state: "active",
      });
      expect(await code(add(n))).toBe("name_taken");
    },
    T,
  );

  it(
    "made and stopped before its tenant was, is finished by adding it again",
    async () => {
      const n = name();
      const user = `u_${"7".repeat(25)}${names % 10}` as UserId;
      await db.write((tx) =>
        tx.query(
          "INSERT INTO accounts (id, name, password_hash, state) VALUES ($1, $2, 'x', 'active')",
          [user, n],
        ),
      );
      // Stopped after its tenant was registered: a web login and a user session are there.
      const tenant = `tn_${randomCrockford(26)}` as TenantId;
      await cp.registerTenant({
        id: tenant,
        owner: user,
        ref: { kind: "postgres", cell: CELL, database: tenant.toLowerCase() },
      });
      await db.write((tx) =>
        tx.query(
          "INSERT INTO web_logins (id, cookie_hash, user_id, expires_at) VALUES ($1, $2, $3, $4)",
          [`l_${n}`, `${"e".repeat(60)}${String(names).padStart(4, "0")}`, user, NOW],
        ),
      );
      const session = tokenHash(newToken("session"));
      await cp.putCredential({ hash: session, kind: "session", principal: user, tenant });
      const r = await add(n, "the password given again");
      expect(r.user).toBe(user);
      expect((await cp.tenantOf(r.user))?.state).toBe("active");
      // The password is the one given when it was finished, and what came with the old one ended.
      expect((await verifyLocalPassword(accounts.db, n, "the password given again"))?.user).toBe(
        r.user,
      );
      expect(await cp.credential(session)).toBeUndefined();
      const logins = await db.read((tx) =>
        tx.query("SELECT 1 FROM web_logins WHERE user_id = $1", [user]),
      );
      expect(logins.rows).toEqual([]);
    },
    T,
  );

  it(
    "made and stopped with its tenant in another cell: refused, its password left as it was",
    async () => {
      const n = name();
      const r = await registered(n);
      // Its tenant registered in another cell and not made yet.
      await db.write((tx) => tx.query("DELETE FROM tenants WHERE owner = $1", [r.user]));
      const tenant = `tn_${randomCrockford(26)}` as TenantId;
      await cp.registerTenant({
        id: tenant,
        owner: r.user,
        ref: { kind: "postgres", cell: "cell_b", database: tenant.toLowerCase() },
      });
      const refused = addLocalUser(accounts, {
        control: cp,
        backend,
        name: n,
        password: "a second password",
        cell: CELL,
        cells: new Set([CELL, "cell_b"]),
        now: NOW,
      });
      await expect(refused).rejects.toMatchObject({ code: "cell_mismatch" });
      expect((await verifyLocalPassword(accounts.db, n, PASSWORD))?.user).toBe(r.user);
      expect(await verifyLocalPassword(accounts.db, n, "a second password")).toBeUndefined();
    },
    T,
  );

  it(
    "added twice at once in this process: one made, the other refused as taken",
    async () => {
      const n = name();
      const results = await Promise.allSettled([
        add(n, "the first password"),
        add(n, "the second password"),
      ]);
      expect(results.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
      const lost = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: "name_taken" });
      const won = results.findIndex((x) => x.status === "fulfilled");
      const passwords = ["the first password", "the second password"];
      expect(await verifyLocalPassword(accounts.db, n, passwords[won] as string)).toBeDefined();
      expect(
        await verifyLocalPassword(accounts.db, n, passwords[1 - won] as string),
      ).toBeUndefined();
    },
    T,
  );

  it(
    "refuses a cell the deployment does not have, writing nothing",
    async () => {
      const n = name();
      const r = addLocalUser(accounts, {
        control: cp,
        backend,
        name: n,
        password: PASSWORD,
        cell: "cell_elsewhere",
        cells: new Set([CELL]),
        now: NOW,
      });
      await expect(r).rejects.toBeInstanceOf(ServerTenantError);
      await expect(r).rejects.toMatchObject({ code: "unknown_cell" });
      expect((await listLocalUsers(accounts)).some((u) => u.name === n)).toBe(false);
    },
    T,
  );

  it(
    "refuses a name or a password it does not take",
    async () => {
      expect(await code(add("-leading"))).toBe("bad_name");
      expect(await code(add("Robin"))).toBe("bad_name");
      expect(await code(add("robin\u00e9"))).toBe("bad_name");
      expect(await code(add("a".repeat(65)))).toBe("bad_name");
      expect(await code(add(name(), "short"))).toBe("bad_password");
      expect(await code(add(name(), "p".repeat(1025)))).toBe("bad_password");
    },
    T,
  );
});

describe("a password changed", () => {
  it(
    "ends the user's sessions and web logins; its connections keep their credentials",
    async () => {
      const n = name();
      const r = await registered(n);
      const issued = await session(r.user);
      const connection = tokenHash(newToken("connection"));
      await cp.putCredential({
        hash: connection,
        kind: "connection",
        principal: `ci_${"5".repeat(26)}`,
        tenant: r.tenant,
      });
      // A connection the user issued is registered under its own ID, not the user's: what a
      // removal by the user's ID must leave is a connection credential recorded under the user.
      const underUser = tokenHash(newToken("connection"));
      await cp.putCredential({
        hash: underUser,
        kind: "connection",
        principal: r.user,
        tenant: r.tenant,
      });
      await db.write((tx) =>
        tx.query(
          "INSERT INTO web_logins (id, cookie_hash, user_id, expires_at) VALUES ($1, $2, $3, $4)",
          ["l1", "h".repeat(64), r.user, "2026-11-21T10:00:00.000Z"],
        ),
      );
      await setLocalPassword(accounts, { name: n, password: "another long one", now: NOW });
      expect(await verifyLocalPassword(accounts.db, n, PASSWORD)).toBeUndefined();
      expect((await verifyLocalPassword(accounts.db, n, "another long one"))?.user).toBe(r.user);
      expect(await cp.credential(tokenHash(issued))).toBeUndefined();
      expect(await cp.credential(connection)).toBeDefined();
      expect(await cp.credential(underUser)).toBeDefined();
      const logins = await db.read((tx) =>
        tx.query("SELECT 1 FROM web_logins WHERE user_id = $1", [r.user]),
      );
      expect(logins.rows).toEqual([]);
      expect(
        await code(setLocalPassword(accounts, { name: "nobody", password: PASSWORD, now: NOW })),
      ).toBe("unknown_user");
    },
    T,
  );
});

describe("an account disabled", () => {
  it(
    "is listed so, signs in to nothing, keeps its credentials and web logins, and is active again when enabled",
    async () => {
      const n = name();
      const r = await registered(n);
      const issued = await session(r.user);
      await db.write((tx) =>
        tx.query(
          "INSERT INTO web_logins (id, cookie_hash, user_id, expires_at) VALUES ($1, $2, $3, $4)",
          [`l_${n}`, `${"d".repeat(60)}${String(names).padStart(4, "0")}`, r.user, NOW],
        ),
      );
      await disableLocalUser(accounts, { name: n });
      expect((await listLocalUsers(accounts)).find((u) => u.user === r.user)?.state).toBe(
        "disabled",
      );
      expect(await verifyLocalPassword(accounts.db, n, PASSWORD)).toBeUndefined();
      expect(await cp.credential(tokenHash(issued))).toBeDefined();
      const logins = await db.read((tx) =>
        tx.query("SELECT 1 FROM web_logins WHERE user_id = $1", [r.user]),
      );
      expect(logins.rows).toHaveLength(1);
      await enableLocalUser(accounts, { name: n });
      await enableLocalUser(accounts, { name: n });
      expect((await listLocalUsers(accounts)).find((u) => u.user === r.user)?.state).toBe("active");
      expect((await verifyLocalPassword(accounts.db, n, PASSWORD))?.user).toBe(r.user);
      expect(await code(disableLocalUser(accounts, { name: "nobody" }))).toBe("unknown_user");
      expect(await code(enableLocalUser(accounts, { name: "nobody" }))).toBe("unknown_user");
    },
    T,
  );
});

describe("a user session written", () => {
  it(
    "is recorded by its token's hash, with its expiry and grant, for the user's active tenant",
    async () => {
      const r = await registered(name());
      const token = await session(r.user, "g_1");
      expect(token).toMatch(/^sls_/);
      expect(await cp.credential(tokenHash(token))).toEqual({
        hash: tokenHash(token),
        kind: "session",
        principal: r.user,
        tenant: r.tenant,
        expiresAt: LATER,
        grant: "g_1",
      });
      expect(await sessionsOf(r.user)).toBe(1);
    },
    T,
  );

  it(
    "is not written for a user without a tenant, or whose tenant is not active yet",
    async () => {
      const userCode = async (user: UserId) => {
        try {
          await session(user);
        } catch (e) {
          if (e instanceof UserSessionError) return e.code;
          throw e;
        }
        return "no error";
      };
      expect(await userCode(`u_${"0".repeat(26)}` as UserId)).toBe("unknown_user");
      const owner = `u_${randomCrockford(26)}` as UserId;
      const creating = `tn_${randomCrockford(26)}` as TenantId;
      await cp.registerTenant({
        id: creating,
        owner,
        ref: { kind: "postgres", cell: CELL, database: creating.toLowerCase() },
      });
      expect(await userCode(owner)).toBe("tenant_not_active");
      expect(await sessionsOf(owner)).toBe(0);
      const r = await registered(name());
      await expect(
        db.write((tx) => writeUserSession(tx, r.user, { expiresAt: "2026-11-21T10:00:00Z" })),
      ).rejects.toThrow("an instant as toISOString writes it");
      expect(await sessionsOf(r.user)).toBe(0);
    },
    T,
  );
});
