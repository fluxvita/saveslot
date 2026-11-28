// `saveslot server user …` and `server init --user` (06-cli §4.1 «服务器自部署的运维命令», §6.2) on a
// real control database, on either backend (`pnpm test:postgres` runs this file on PostgreSQL), and
// what they change as a running server sees it: an account made with its tenant, listed; a password
// changed ending the web logins and user sessions but not the connections; an account disabled and
// enabled again; the external login refusing them all before the database is opened; the password
// read from a file or the terminal, never anything done without one. Fictional names.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExternalIdentity,
  LocalIdentity,
  openControlPlane,
  openExternalLogin,
  openLocalAccounts,
  type TenantPoolOptions,
  type UserId,
  UserSessionError,
  writeUserSession,
} from "@fluxvita/saveslot-service";
import type { ControlDatabase } from "@fluxvita/saveslot-store-postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  GOOD_HEADER,
  goodClaims,
  signAssertion,
  TEST_ISSUER,
  TEST_KEY,
} from "../../service/src/external-assertion.fixture.ts";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import { type RunningServer, runServer } from "./run-server.ts";
import { serverCommand } from "./server-commands.ts";
import { readServerConfig } from "./server-config.ts";
import { PasswordInterrupted, type PasswordTerminal } from "./server-password.ts";
import type { ServerRestoreIO } from "./server-restore-command.ts";

type Store = Awaited<ReturnType<ReturnType<typeof testBackend>["open"]>>;

const T = 120_000;
const AS_ROOT = process.getuid?.() === 0;
const root = mkdtempSync(join(tmpdir(), "saveslot-server-user-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);
let n = 0;
const stores: Store[] = [];
afterAll(async () => {
  for (const s of stores) await s.close().catch(() => {});
}, T);

const FIRST = "correct horse battery";
const SECOND = "staple paper clip 42";

/** A file holding `text`, of `mode`. */
function passwordFile(text: string, mode = 0o600): string {
  const path = join(root, `pw${n++}`);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

/** A terminal that gives `entries` in turn, and records what it was asked. */
function fakeTerminal(entries: (string | Error)[]) {
  const t = {
    asked: [] as string[],
    closed: 0,
    readHidden: async (prompt: string) => {
      t.asked.push(prompt);
      const e = entries.shift();
      if (e === undefined) throw new Error("asked once too often");
      if (e instanceof Error) throw e;
      return e;
    },
    close: () => {
      t.closed++;
    },
  };
  return t satisfies PasswordTerminal;
}

/** A server tenant's database is a directory of the test backend. */
function tenants(): TenantPoolOptions["backend"] {
  const dir = join(root, `tenants${n++}`);
  return {
    open: async (ref, opts) => {
      if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
      return testBackend().open({ kind: "pglite", dir: join(dir, ref.cell, ref.database) }, opts);
    },
  };
}

function env(): Record<string, string> {
  const keys = join(root, `keys${n++}`);
  mkdirSync(keys, { mode: 0o700 });
  return {
    SAVESLOT_CONTROL_DATABASE_URL: "postgres://saveslot@db.internal/saveslot_control",
    SAVESLOT_CELL_DATABASE_URL: "postgres://saveslot@db.internal/postgres",
    SAVESLOT_PUBLIC_URL: "http://127.0.0.1:8080",
    SAVESLOT_HANDLE_KEY_FILE: join(keys, "handle-key"),
  };
}

function externalEnv(): Record<string, string> {
  const keysFile = join(root, `platform-keys${n++}.json`);
  writeFileSync(keysFile, JSON.stringify({ keys: [TEST_KEY.public] }), { mode: 0o600 });
  return {
    SAVESLOT_IDENTITY_ISSUER: "https://platform.example",
    SAVESLOT_IDENTITY_LOGIN_URL: "https://platform.example/login",
    SAVESLOT_IDENTITY_KEYS_FILE: keysFile,
  };
}

/**
 * A deployment: a control database of its own (closing it from a command leaves it open for the
 * test), its tenants' storage, its configuration; `run` runs a `saveslot server` command on it,
 * with no terminal unless one is given.
 */
async function deployment(o: { init?: boolean } = {}) {
  const store = await testBackend().open(
    { kind: "pglite", dir: join(root, `control${n++}`) },
    { create: true },
  );
  stores.push(store);
  const db: ControlDatabase = {
    read: store.read.bind(store),
    write: store.write.bind(store),
    close: async () => {},
    onLost: () => {},
  };
  const backend = tenants();
  const e = env();
  let opened = 0;
  const run = async (argv: string[], over: Partial<ServerRestoreIO> = {}) => {
    let out = "";
    let err = "";
    const code = await serverCommand(argv, {
      env: e,
      out: (l) => {
        out += `${l}\n`;
      },
      err: (l) => {
        err += `${l}\n`;
      },
      openControl: async () => {
        opened++;
        return db;
      },
      backend,
      terminal: () => undefined,
      ...over,
    });
    return { code, out, err };
  };
  if (o.init !== false) expect((await run(["init"])).code).toBe(0);
  opened = 0;
  return { store, db, backend, env: e, run, opened: () => opened };
}
type Deployment = Awaited<ReturnType<typeof deployment>>;

/** The account's user, by name. */
const userOf = async (d: Deployment, name: string) =>
  (
    await d.store.read((tx) =>
      tx.query<{ id: string }>("SELECT id FROM accounts WHERE name = $1", [name]),
    )
  ).rows[0]?.id as UserId | undefined;

const accountNames = async (d: Deployment) =>
  (
    await d.store.read((tx) =>
      tx.query<{ name: string }>("SELECT name FROM accounts ORDER BY name"),
    )
  ).rows.map((r) => r.name);

/** A server on the deployment's control database, on a port of the system's. */
const serve = (d: Deployment) =>
  runServer({
    config: {
      ...readServerConfig(d.env),
      listen: { host: "127.0.0.1", port: 0 },
      trustedProxies: [],
      allowedOrigins: [],
    },
    version: "0.0.0-test",
    openControl: async () => d.db,
    backend: d.backend,
  });

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function send(
  s: RunningServer,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: s.address.host,
        port: s.address.port,
        method: o.method ?? "GET",
        path: o.path,
        headers: o.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (c: string) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

const LOGIN_PAGE = "/account/login?return_to=%2Foauth%2F";

/** A login on the local accounts' page: its status, and the login cookie it set. */
async function login(s: RunningServer, name: string, password: string) {
  const page = await send(s, { path: LOGIN_PAGE });
  const token = /name="form_token" value="([^"]+)"/.exec(page.body)?.[1];
  const form = [page.headers["set-cookie"]].flat()[0]?.split(";")[0];
  if (token === undefined || form === undefined) throw new Error("no login form");
  const r = await send(s, {
    method: "POST",
    path: "/account/login",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: form },
    body: new URLSearchParams({
      form_token: token,
      return_to: "/oauth/",
      name,
      password,
    }).toString(),
  });
  const cookie = [r.headers["set-cookie"]].flat().find((c) => c?.startsWith("saveslot_login="));
  return { status: r.status, cookie };
}

const slots = (s: RunningServer, token: string) =>
  send(s, { path: "/v1/slots", headers: { authorization: `Bearer ${token}` } });

describe("saveslot server user add: its tenant waiting past its turn to be made", () => {
  it(
    "7, to run it again in a moment; running it again finishes the account",
    async () => {
      const d = await deployment();
      // As the PostgreSQL backend refuses a database to make while another is made or dropped.
      const busy = {
        open: async () => {
          throw Object.assign(new Error("busy"), { code: "maintenance_busy" });
        },
      };
      const r = await d.run(["user", "add", "drew", "--password-file", passwordFile(FIRST)], {
        backend: busy,
      });
      expect(r.code).toBe(7);
      expect(r.err).toContain("run the command again in a moment");
      const again = await d.run(["user", "add", "drew", "--password-file", passwordFile(FIRST)]);
      expect(again.code).toBe(0);
    },
    T,
  );
});

describe("saveslot server user add and list", () => {
  it(
    "add makes the account and its tenant; list gives name, state and tenant, by name",
    async () => {
      const d = await deployment();
      expect((await d.run(["user", "list"])).out).toBe(
        "There are no local accounts; add one with saveslot server user add <name>\n",
      );
      const blair = await d.run(["user", "add", "blair", "--password-file", passwordFile(FIRST)]);
      expect(blair.code).toBe(0);
      expect(blair.out).toMatch(/^Added the account blair · tenant tn_[0-9A-Z]{26}\n$/);
      const alex = await d.run(["user", "add", "alex", "--password-file", passwordFile(FIRST)]);
      expect(alex.code).toBe(0);
      const list = await d.run(["user", "list"]);
      expect(list.code).toBe(0);
      const tenantOf = (r: { out: string }) => /tenant (tn_\w+)/.exec(r.out)?.[1];
      expect(list.out).toBe(
        `alex   active    ${tenantOf(alex)}\nblair  active    ${tenantOf(blair)}\n`,
      );
    },
    T,
  );

  it(
    "a name taken, a name not valid, a password too short: 5, nothing written",
    async () => {
      const d = await deployment();
      expect(
        (await d.run(["user", "add", "alex", "--password-file", passwordFile(FIRST)])).code,
      ).toBe(0);
      const taken = await d.run(["user", "add", "alex", "--password-file", passwordFile(SECOND)]);
      expect(taken).toMatchObject({ code: 5 });
      expect(taken.err).toContain('an account named "alex" is there already');
      const badName = await d.run(["user", "add", "Alex!", "--password-file", passwordFile(FIRST)]);
      expect(badName.code).toBe(5);
      expect(badName.err).toContain("is not one an account can have");
      const short = await d.run(["user", "add", "casey", "--password-file", passwordFile("short")]);
      expect(short.code).toBe(5);
      expect(short.err).toContain("8 to 1024 characters");
      expect(await accountNames(d)).toEqual(["alex"]);
    },
    T,
  );

  it(
    "tables not made yet: 5, telling to run server init",
    async () => {
      const d = await deployment({ init: false });
      const r = await d.run(["user", "list"]);
      expect(r.code).toBe(5);
      expect(r.err).toContain("run saveslot server init first");
    },
    T,
  );
});

describe("the password: from a file or the terminal, never without one", () => {
  it(
    "no terminal and no file: 8, the control database not opened (add, passwd, init --user)",
    async () => {
      const d = await deployment();
      for (const argv of [
        ["user", "add", "alex"],
        ["user", "passwd", "alex"],
        ["init", "--user", "alex"],
      ]) {
        const r = await d.run(argv);
        expect(r.code).toBe(8);
        expect(r.err).toContain(
          "there is no terminal to ask the password on; give --password-file",
        );
      }
      expect(d.opened()).toBe(0);
      expect(await accountNames(d)).toEqual([]);
    },
    T,
  );

  it.each([
    ["open to others", () => passwordFile(FIRST, 0o604), "is open to others"],
    [
      "a directory",
      () => {
        const dir = join(root, `dir${n++}`);
        mkdirSync(dir);
        return dir;
      },
      "is not a regular file",
    ],
    ["missing", () => join(root, "not-there"), "is not there"],
    ["empty", () => passwordFile(""), "has no password on its first line"],
  ] as const)(
    "a password file %s: 2, nothing opened or made; the message holds no content",
    async (_, make, what) => {
      const d = await deployment();
      const r = await d.run(["user", "add", "alex", "--password-file", make()]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(what);
      expect(r.err).not.toContain(FIRST);
      expect(d.opened()).toBe(0);
      expect(await accountNames(d)).toEqual([]);
    },
    T,
  );

  it.skipIf(AS_ROOT)(
    "a password file this process may not read: 2",
    async () => {
      const d = await deployment();
      const r = await d.run(["user", "add", "alex", "--password-file", passwordFile(FIRST, 0o000)]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("cannot be read: give this process's user read permission");
      expect(d.opened()).toBe(0);
    },
    T,
  );

  it.each([
    [
      "a loop of links",
      () => {
        const a = join(root, `loop-a${n}`);
        const b = join(root, `loop-b${n++}`);
        symlinkSync(b, a);
        symlinkSync(a, b);
        return a;
      },
    ],
    ["a name too long", () => join(root, "x".repeat(300))],
    ["a path through a file", () => join(passwordFile(FIRST), "inside")],
  ] as const)(
    "a password file behind %s: 2, cannot be read; no stack, no path",
    async (_, make) => {
      const d = await deployment();
      const r = await d.run(["user", "add", "alex", "--password-file", make()]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("cannot be read");
      expect(r.err).not.toContain(root);
      expect(r.err).not.toMatch(/\n\s+at /);
      expect(d.opened()).toBe(0);
    },
    T,
  );

  it(
    "the terminal: asked twice, again when they differ; closed after",
    async () => {
      const d = await deployment();
      const t = fakeTerminal([FIRST, "not the same", FIRST, FIRST]);
      const r = await d.run(["user", "add", "alex"], { terminal: () => t });
      expect(r.code).toBe(0);
      expect(t.asked).toHaveLength(4);
      expect(t.closed).toBe(1);
      const s = await serve(d);
      try {
        expect((await login(s, "alex", FIRST)).status).toBe(303);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "the terminal: different every time, 2; Ctrl-C, 130; nothing opened or made",
    async () => {
      const d = await deployment();
      const differ = fakeTerminal([
        "a1a1a1a1",
        "b2b2b2b2",
        "c3c3c3c3",
        "d4d4d4d4",
        "e5e5e5e5",
        "f6f6f6f6",
      ]);
      const r = await d.run(["user", "add", "alex"], { terminal: () => differ });
      expect(r.code).toBe(2);
      expect(r.err).toContain("the two entries differed");
      expect(differ.closed).toBe(1);
      const stopped = fakeTerminal([new PasswordInterrupted("interrupted")]);
      expect((await d.run(["user", "add", "alex"], { terminal: () => stopped })).code).toBe(130);
      expect(d.opened()).toBe(0);
      expect(await accountNames(d)).toEqual([]);
    },
    T,
  );
});

describe("saveslot server user passwd", () => {
  it(
    "ends the account's web logins and user sessions, and refreshes granted before; its connections go on",
    async () => {
      const d = await deployment();
      expect(
        (await d.run(["user", "add", "alex", "--password-file", passwordFile(FIRST)])).code,
      ).toBe(0);
      const user = (await userOf(d, "alex")) as UserId;
      const s = await serve(d);
      try {
        expect((await login(s, "alex", FIRST)).status).toBe(303);
        const logins = async () =>
          (
            await d.store.read((tx) =>
              tx.query("SELECT 1 FROM web_logins WHERE user_id = $1", [user]),
            )
          ).rows.length;
        expect(await logins()).toBe(1);
        const session = await d.store.write((tx) =>
          writeUserSession(tx, user, { expiresAt: "2099-01-01T00:00:00.000Z" }),
        );
        expect((await slots(s, session)).status).toBe(200);
        const issued = await send(s, {
          method: "POST",
          path: "/v1/connections",
          headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "notes host" }),
        });
        expect(issued.status).toBe(200);
        const connection = String(JSON.parse(issued.body)["token"]);
        // The password file's first line is the password; what follows is not read.
        const r = await d.run([
          "user",
          "passwd",
          "alex",
          "--password-file",
          passwordFile(`${SECOND}\r\nignored`),
        ]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("its web logins and user sessions have ended");
        expect(await logins()).toBe(0);
        expect((await slots(s, session)).status).toBe(401);
        expect((await slots(s, connection)).status).toBe(200);
        // A refresh of a session granted before the change issues nothing.
        const identity = new LocalIdentity({
          accounts: await openLocalAccounts(d.db),
          loginMs: 60_000,
          origin: "http://127.0.0.1:8080",
          formKeys: {
            current: "k0000000000000001",
            byId: new Map([["k0000000000000001", Buffer.alloc(32, 1)]]),
          },
          now: () => Date.now(),
        });
        const now = new Date().toISOString();
        await expect(
          identity.issueUserSession(user, {
            from: { refresh: { grantedAt: "2026-01-01T00:00:00.000Z" } },
            expiresAt: "2099-01-01T00:00:00.000Z",
            now,
          }),
        ).rejects.toMatchObject({ name: UserSessionError.name, code: "login_ended" });
        expect((await login(s, "alex", FIRST)).status).toBe(401);
        expect((await login(s, "alex", SECOND)).status).toBe(303);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "an account that is not there: 4",
    async () => {
      const d = await deployment();
      const r = await d.run(["user", "passwd", "nobody", "--password-file", passwordFile(SECOND)]);
      expect(r.code).toBe(4);
      expect(r.err).toContain('there is no account named "nobody"');
    },
    T,
  );
});

describe("saveslot server user disable and enable", () => {
  it(
    "disabled: its credentials refused as account_disabled, list says so; enabled: as they were",
    async () => {
      const d = await deployment();
      expect(
        (await d.run(["user", "add", "alex", "--password-file", passwordFile(FIRST)])).code,
      ).toBe(0);
      const user = (await userOf(d, "alex")) as UserId;
      const session = await d.store.write((tx) =>
        writeUserSession(tx, user, { expiresAt: "2099-01-01T00:00:00.000Z" }),
      );
      const s = await serve(d);
      try {
        expect((await slots(s, session)).status).toBe(200);
        const off = await d.run(["user", "disable", "alex"]);
        expect(off.code).toBe(0);
        expect(off.out).toContain("nothing was revoked");
        expect((await d.run(["user", "disable", "alex"])).code).toBe(0);
        const refused = await slots(s, session);
        expect(refused.status).toBe(401);
        expect(refused.body).toContain("account_disabled");
        expect((await d.run(["user", "list"])).out).toMatch(/^alex {2}disabled {2}tn_/);
        expect((await d.run(["user", "enable", "alex"])).code).toBe(0);
        expect((await slots(s, session)).status).toBe(200);
        expect((await d.run(["user", "list"])).out).toMatch(/^alex {2}active {4}tn_/);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "an account that is not there: 4",
    async () => {
      const d = await deployment();
      for (const sub of ["disable", "enable"]) {
        const r = await d.run(["user", sub, "nobody"]);
        expect(r.code).toBe(4);
      }
    },
    T,
  );
});

describe("with the external login configured", () => {
  it(
    "every user subcommand and init --user: 5, before the control database is opened or a password asked",
    async () => {
      const d = await deployment({ init: false });
      const t = fakeTerminal([FIRST, FIRST]);
      for (const argv of [
        ["user", "add", "alex"],
        ["user", "list"],
        ["user", "disable", "alex"],
        ["user", "enable", "alex"],
        ["user", "passwd", "alex"],
        ["init", "--user", "alex"],
      ]) {
        const r = await d.run(argv, { env: { ...d.env, ...externalEnv() }, terminal: () => t });
        expect(r.code).toBe(5);
        expect(r.err).toContain("the external login manages the accounts");
      }
      expect(d.opened()).toBe(0);
      expect(t.asked).toEqual([]);
    },
    T,
  );
});

describe("with the external login configured: disable and enable an account by its subject", () => {
  /** A deployment on the external login, and an account of it signed in once: its user session. */
  async function signedIn(sub: string) {
    const d = await deployment({ init: false });
    const ext = { ...d.env, ...externalEnv() };
    expect((await d.run(["init"], { env: ext })).code).toBe(0);
    const config = readServerConfig(ext);
    // The account's first assertion makes its user and tenant, as the platform's sign-in does.
    const platform = new ExternalIdentity({
      logins: await openExternalLogin(d.db),
      config: {
        issuer: TEST_ISSUER,
        loginUrl: "https://platform.example/login",
        keys: [TEST_KEY.public],
        audience: config.publicUrl,
      },
      control: await openControlPlane(d.db),
      backend: d.backend,
      cell: config.cellName,
      cells: new Set([config.cellName]),
    });
    const made = await platform.acceptAssertion(
      signAssertion(GOOD_HEADER, {
        ...goodClaims(Date.now(), { purpose: "session", sub }),
        aud: config.publicUrl,
      }),
      "198.51.100.7",
    );
    if (made === undefined) throw new Error("the assertion made no user");
    const session = await d.store.write((tx) =>
      writeUserSession(tx, made.user, { expiresAt: "2099-01-01T00:00:00.000Z" }),
    );
    const s = await runServer({
      config: {
        ...config,
        listen: { host: "127.0.0.1", port: 0 },
        trustedProxies: [],
        allowedOrigins: [],
      },
      version: "0.0.0-test",
      openControl: async () => d.db,
      backend: d.backend,
    });
    const run = (argv: string[]) => d.run(argv, { env: ext });
    return { d, s, session, run };
  }

  it(
    "disabled: its credentials refused as account_disabled; again: no change; enabled: as they were",
    async () => {
      const { s, session, run } = await signedIn("acct_alex");
      try {
        expect((await slots(s, session)).status).toBe(200);
        const off = await run(["user", "disable", "--subject", "acct_alex"]);
        expect(off.code).toBe(0);
        expect(off.out).toContain(`Disabled the account acct_alex of ${TEST_ISSUER}`);
        expect(off.out).toContain("nothing was revoked");
        expect((await run(["user", "disable", "--subject", "acct_alex"])).code).toBe(0);
        const refused = await slots(s, session);
        expect(refused.status).toBe(401);
        expect(refused.body).toContain("account_disabled");
        // The issuer given as configured: the same account.
        const on = await run(["user", "enable", "--subject", "acct_alex", "--issuer", TEST_ISSUER]);
        expect(on.code).toBe(0);
        expect(on.out).toContain("authenticate again");
        expect((await run(["user", "enable", "--subject", "acct_alex"])).code).toBe(0);
        expect((await slots(s, session)).status).toBe(200);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "an account that is not there (another subject, or another issuer): 4, nothing changed",
    async () => {
      const { s, session, run } = await signedIn("acct_blair");
      try {
        for (const argv of [
          ["user", "disable", "--subject", "acct_nobody"],
          ["user", "disable", "--subject", "acct_blair", "--issuer", "https://other.example"],
        ]) {
          const r = await run(argv);
          expect(r.code).toBe(4);
          expect(r.err).toContain("there is no account");
        }
        expect((await slots(s, session)).status).toBe(200);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "its tables not made (no server init): 5",
    async () => {
      const d = await deployment({ init: false });
      const r = await d.run(["user", "disable", "--subject", "acct_alex"], {
        env: { ...d.env, ...externalEnv() },
      });
      expect(r.code).toBe(5);
      expect(r.err).toContain("external login tables are not there");
    },
    T,
  );

  it(
    "--subject and --issuer: usage errors (2) where they do not fit, before the database is opened",
    async () => {
      const d = await deployment();
      const ext = { ...d.env, ...externalEnv() };
      for (const [argv, env] of [
        // Without the external login.
        [["user", "disable", "--subject", "acct_alex"], d.env],
        // Another subcommand, a name besides, twice, empty, or an issuer alone.
        [["user", "add", "--subject", "acct_alex"], ext],
        [["user", "disable", "alex", "--subject", "acct_alex"], ext],
        [["user", "disable", "--subject", "a", "--subject", "b"], ext],
        [["user", "disable", "--subject", ""], ext],
        [["user", "disable", "--issuer", TEST_ISSUER], ext],
      ] as const) {
        const before = d.opened();
        const r = await d.run([...argv], { env });
        expect(r.code, argv.join(" ")).toBe(2);
        expect(d.opened()).toBe(before);
      }
    },
    T,
  );
});

describe("saveslot server init --user", () => {
  it(
    "makes the first account and its tenant; run again, none more, and no password asked",
    async () => {
      const d = await deployment({ init: false });
      const first = await d.run(["init", "--user", "alex", "--password-file", passwordFile(FIRST)]);
      expect(first.code).toBe(0);
      expect(first.out).toMatch(/Made the first account, alex · tenant tn_\w+\n$/);
      const t = fakeTerminal([SECOND, SECOND]);
      const again = await d.run(["init", "--user", "blair"], { terminal: () => t });
      expect(again.code).toBe(0);
      expect(again.out).toContain("There are local accounts already: no first account made");
      expect(t.asked).toEqual([]);
      expect(t.closed).toBe(1);
      expect(await accountNames(d)).toEqual(["alex"]);
      const s = await serve(d);
      try {
        expect((await login(s, "alex", FIRST)).status).toBe(303);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "an account an earlier init left without its tenant: run again with its name, it is finished; with another name, nothing is made",
    async () => {
      const d = await deployment({ init: false });
      // The tenant's database cannot be made this time: the account is written, its tenant not.
      const broken: TenantPoolOptions["backend"] = {
        open: async () => {
          throw new Error("the cell is not reachable");
        },
      };
      await expect(
        d.run(["init", "--user", "alex", "--password-file", passwordFile(FIRST)], {
          backend: broken,
        }),
      ).rejects.toThrow("the cell is not reachable");
      expect(await accountNames(d)).toEqual(["alex"]);
      expect((await d.run(["user", "list"])).out).toContain(
        "(no tenant: run saveslot server user add again)",
      );
      // Another name: the half-made account is an account; nothing is made, no password asked.
      const t = fakeTerminal([]);
      const other = await d.run(["init", "--user", "blair"], { terminal: () => t });
      expect(other.code).toBe(0);
      expect(other.out).toContain("There are local accounts already: no first account made");
      expect(t.asked).toEqual([]);
      // Its own name: finished, with the password given this time.
      const again = await d.run([
        "init",
        "--user",
        "alex",
        "--password-file",
        passwordFile(SECOND),
      ]);
      expect(again.code).toBe(0);
      expect(again.out).toMatch(
        /Finished the account alex, which an earlier run left without its tenant · tenant tn_\w+\n$/,
      );
      expect((await d.run(["user", "list"])).out).toMatch(/^alex {2}active {4}tn_/);
      expect(await accountNames(d)).toEqual(["alex"]);
      const s = await serve(d);
      try {
        expect((await login(s, "alex", SECOND)).status).toBe(303);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "without --user: no account, and a hint",
    async () => {
      const d = await deployment({ init: false });
      const r = await d.run(["init"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("No account made: add one with saveslot server user add <name>");
      expect(await accountNames(d)).toEqual([]);
    },
    T,
  );

  it(
    "a name not valid: 5, before anything is made",
    async () => {
      const d = await deployment({ init: false });
      const r = await d.run(["init", "--user", "Alex!", "--password-file", passwordFile(FIRST)]);
      expect(r.code).toBe(5);
      expect(d.opened()).toBe(0);
    },
    T,
  );

  it(
    "a password file's password too short: 5, before anything is made (no key file, nothing opened)",
    async () => {
      const d = await deployment({ init: false });
      const r = await d.run(["init", "--user", "alex", "--password-file", passwordFile("short")]);
      expect(r.code).toBe(5);
      expect(r.err).toContain("8 to 1024 characters; nothing was done");
      expect(d.opened()).toBe(0);
      expect(existsSync(d.env["SAVESLOT_HANDLE_KEY_FILE"] as string)).toBe(false);
    },
    T,
  );

  it.each([
    [
      "the entries differing each time",
      2,
      () => ["a1a1a1a1", "b2b2b2b2", "c3c3c3c3", "d4d4d4d4", "e5e5e5e5", "f6f6f6f6"],
    ],
    ["Ctrl-C at the prompt", 130, () => [new PasswordInterrupted("interrupted")]],
    ["a password too short", 5, () => ["short", "short"]],
  ] as const)(
    "on the terminal, %s: %i, saying the key file and tables are in place and the account was not made; run again, it is",
    async (_, code, entries) => {
      const d = await deployment({ init: false });
      const t = fakeTerminal([...entries()]);
      const r = await d.run(["init", "--user", "alex"], { terminal: () => t });
      expect(r.code).toBe(code);
      expect(r.out).toContain("The control database's tables are in place");
      expect(r.err).toContain(
        "the handle key file and the control database's tables are in place, the account was not made: run saveslot server init --user again",
      );
      expect(r.err).not.toContain("nothing was done");
      expect(await accountNames(d)).toEqual([]);
      const again = await d.run(["init", "--user", "alex"], {
        terminal: () => fakeTerminal([FIRST, FIRST]),
      });
      expect(again.code).toBe(0);
      expect(again.out).toContain("Made the first account, alex");
    },
    T,
  );
});

describe("usage", () => {
  it.each([[["init", "pw-typed-as-argument"]], [["start", "pw-typed-as-argument"]]])(
    "%j: 2, the usage said, the argument not echoed",
    async (argv) => {
      let err = "";
      const code = await serverCommand(argv, {
        env: {},
        out: () => {},
        err: (l) => {
          err += l;
        },
        terminal: () => undefined,
      });
      expect(code).toBe(2);
      expect(err).toContain("usage: saveslot server");
      expect(err).not.toContain("pw-typed-as-argument");
    },
  );

  it.each([
    [["user"]],
    [["user", "rename", "alex"]],
    [["user", "add"]],
    [["user", "add", "alex", "blair"]],
    [["user", "list", "alex"]],
    [["user", "disable"]],
    [["user", "disable", "alex", "--password-file", "/tmp/x"]],
    [["user", "add", "alex", "--password-file", "/tmp/x", "--password-file", "/tmp/y"]],
    [["user", "add", "alex", "--password", "hunter22"]],
    [["init", "--user", "alex", "--user", "blair"]],
    [["init", "--password-file", "/tmp/x"]],
  ])("%j: 2, nothing opened", async (argv) => {
    let opened = 0;
    const code = await serverCommand(argv, {
      env: {},
      out: () => {},
      err: () => {},
      openControl: async () => {
        opened++;
        throw new Error("not to be opened");
      },
      terminal: () => undefined,
    });
    expect(code).toBe(2);
    expect(opened).toBe(0);
  });
});
