// Local credentials against a real tenant (02-architecture §5 «身份»; 04-contract §12, §16; 06-cli
// §2, §3.2): init makes the session token and its hash; the session authenticates as the user; an
// issued connection token authenticates as that connection with its scopes and slot range, read
// from the tenant on every request; a revoked one is refused as `revoked`, after a restart too; an
// issue that did not commit leaves a token that authenticates as nothing, its hash dropped at the
// next start; rotating the session is refused while the service runs and otherwise makes the old
// token useless. No token appears anywhere but the issue result's `token` field and the session
// file: not in results, refusals, errors or the service's log.

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlreadyInitialized,
  authenticate,
  type Credentials,
  Credentials as CredentialsClass,
  closeLocalTenant,
  credentialsFile,
  initLocalHome,
  issueLocalConnection,
  type LocalTenant,
  localUserContext,
  newToken,
  openLocalTenant,
  pruneCredentials,
  revokeLocalConnection,
  rotateSession,
  ServiceRunning,
  sessionFile,
  tokenHash,
} from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { runService } from "./service.ts";

const T = 60_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-credentials-"));
const home = join(root, "home");
let t: LocalTenant | undefined;
let creds: Credentials;
const now = "2026-11-16T09:00:00.000Z";

/** Everything that came back or was thrown, and every log line: no token may be in any of it. */
const seen: string[] = [];
const TOKEN = /(sls|slt)_[A-Za-z0-9_-]{43}/;

const tenant = () => t as LocalTenant;
const ctx = () => localUserContext(tenant(), { now });
const auth = async (authorization: string | undefined) => {
  const r = await authenticate({ credentials: creds, tenant: tenant(), authorization });
  seen.push(JSON.stringify(r));
  return r;
};
/** A promise's refusal, kept with its message and detail for the leak check. */
async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    const x = e as { message?: string; code?: string; detail?: unknown };
    seen.push(`${x.message ?? ""} ${JSON.stringify(x.detail ?? {})} ${x.code ?? ""}`);
    return e;
  }
  throw new Error("not refused");
}
const sessionToken = () => readFileSync(sessionFile(home), "utf8").trim();
async function open(): Promise<void> {
  const r = await openLocalTenant({
    home,
    dataDir: join(home, "data"),
    backend: testBackend(),
  });
  if (!r.ok) throw new Error(r.failure);
  t = r.tenant;
  creds = await CredentialsClass.load(home);
}
async function close(): Promise<void> {
  if (t !== undefined) await closeLocalTenant(t);
  t = undefined;
}
/** A restart: the tenant reopened, the credentials read from disk, dangling hashes dropped. */
async function restart(): Promise<number> {
  await close();
  await open();
  return pruneCredentials(tenant(), creds);
}
/** Issues a connection; its result is checked to hold the token only in `token`. */
async function issue(name: string) {
  const r = await issueLocalConnection({
    tenant: tenant(),
    credentials: creds,
    ctx: ctx(),
    params: { name },
  });
  seen.push(JSON.stringify({ ...r, token: undefined }));
  return r;
}

beforeAll(async () => {
  await initLocalHome({ home, backend: testBackend(), lock: osFileLock, now });
  await open();
}, T);
afterAll(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
}, T);

describe("init and the user session", () => {
  it("makes the home 0700 and the session file and credentials 0600; the session hash only", () => {
    for (const d of [home, join(home, "run"), join(home, "control"), join(home, "credentials")]) {
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    for (const f of [sessionFile(home), credentialsFile(home)]) {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    const token = sessionToken();
    expect(token).toMatch(/^sls_[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(credentialsFile(home), "utf8")).not.toContain(token);
  });

  it("refuses a home already initialized", async () => {
    expect(
      await refusal(initLocalHome({ home, backend: testBackend(), lock: osFileLock, now })),
    ).toBeInstanceOf(AlreadyInitialized);
  });

  it("the session authenticates as the user, with every scope and the whole tenant", async () => {
    expect(await auth(`Bearer ${sessionToken()}`)).toEqual({
      kind: "user",
      actor: tenant().user,
      scopes: ["saveslot.read", "saveslot.write", "saveslot.schema", "saveslot.delete"],
      visibility: { kind: "all" },
    });
  });

  it("no header: missing; a malformed one or another token: invalid", async () => {
    expect(await auth(undefined)).toEqual({ code: "unauthenticated", reason: "missing" });
    for (const h of [`Bearer ${sessionToken()}x`, "Bearer sls_", `Bearer ${newToken("session")}`]) {
      expect(await auth(h)).toEqual({ code: "unauthenticated", reason: "invalid" });
    }
  });
});

describe("connection tokens", () => {
  let token: string;
  let id: string;

  it("issued: authenticates as the connection, with its scopes", async () => {
    const r = await issue("desk");
    token = r.token;
    id = r.connection.id;
    expect(token).toMatch(/^slt_[A-Za-z0-9_-]{43}$/);
    expect(await auth(`Bearer ${token}`)).toEqual({
      kind: "connection",
      actor: id,
      scopes: ["saveslot.read", "saveslot.write"],
      visibility: { kind: "all" },
    });
    expect((await CredentialsClass.load(home)).principals()).toEqual([id]);
  });

  it("scope and range are read from the tenant on each request: changed there, the next request sees it", async () => {
    // Scopes cannot change in this version (04-contract §12); changed in place here to show the
    // token carries none of them.
    const slot = `sl_${"4".repeat(16)}`;
    await tenant().store.write((tx) =>
      tx.query("UPDATE principals SET scopes = $2, slots = $3 WHERE id = $1", [
        id,
        JSON.stringify(["saveslot.read"]),
        JSON.stringify([slot]),
      ]),
    );
    expect(await auth(`Bearer ${token}`)).toEqual({
      kind: "connection",
      actor: id,
      scopes: ["saveslot.read"],
      visibility: { kind: "scoped", slots: [{ slot }] },
    });
    // An empty list is no slot at all, not every slot.
    await tenant().store.write((tx) =>
      tx.query("UPDATE principals SET slots = '[]' WHERE id = $1", [id]),
    );
    expect(await auth(`Bearer ${token}`)).toMatchObject({
      visibility: { kind: "scoped", slots: [] },
    });
    await tenant().store.write((tx) =>
      tx.query("UPDATE principals SET scopes = $2, slots = NULL WHERE id = $1", [
        id,
        JSON.stringify(["saveslot.read", "saveslot.write"]),
      ]),
    );
  });

  it("revoked: refused as revoked from the next request on, and after a restart", async () => {
    await revokeLocalConnection({ tenant: tenant(), ctx: ctx(), id: id as never });
    expect(await auth(`Bearer ${token}`)).toEqual({ code: "unauthenticated", reason: "revoked" });
    expect(await restart()).toBe(0);
    expect(await auth(`Bearer ${token}`)).toEqual({ code: "unauthenticated", reason: "revoked" });
  });

  it("refused by the kernel (a name in use): nothing registered, no hash left", async () => {
    const before = (await CredentialsClass.load(home)).principals();
    expect(await refusal(issue("desk"))).toMatchObject({ code: "invalid_argument" });
    expect((await CredentialsClass.load(home)).principals()).toEqual(before);
  });

  it("failing before the registration commits: nothing registered, no hash on disk, consistent after a restart", async () => {
    const count = () =>
      tenant().store.read((tx) => tx.query("SELECT count(*) AS n FROM principals"));
    const before = await count();
    let pending = "";
    expect(
      await refusal(
        issueLocalConnection({
          tenant: tenant(),
          credentials: creds,
          ctx: ctx(),
          params: { name: "failed" },
          beforeRegistering: (x) => {
            pending = x;
            throw new Error("failed before registering");
          },
        }),
      ),
    ).toMatchObject({ message: "failed before registering" });
    expect(pending).not.toBe("");
    expect((await count()).rows).toEqual(before.rows);
    expect(readFileSync(credentialsFile(home), "utf8")).not.toContain(pending);
    expect(await restart()).toBe(0);
    expect(creds.principals()).not.toContain(pending);
  });

  it("killed with the hash on disk and nothing registered: the token authenticates as nothing; the next start drops the hash", async () => {
    // What a process killed between the two steps leaves: a hash, on disk, for an ID no principal
    // has (the process got as far as recording it).
    const orphan = newToken("connection");
    const ghost = `ci_${"9".repeat(26)}` as const;
    creds.addConnection(tokenHash(orphan), ghost);
    await close();
    await open();
    expect(await auth(`Bearer ${orphan}`)).toEqual({ code: "unauthenticated", reason: "invalid" });
    expect(await pruneCredentials(tenant(), creds)).toBe(1);
    expect((await CredentialsClass.load(home)).principals()).not.toContain(ghost);
    expect(await auth(`Bearer ${orphan}`)).toEqual({ code: "unauthenticated", reason: "invalid" });
  });
});

describe("rotating the session", () => {
  it(
    "refused while the service runs: neither token changes",
    async () => {
      await close();
      const lines: string[] = [];
      const s = await runService({ home, version: "t", signals: false, log: (l) => lines.push(l) });
      try {
        expect(s.state).toBe("ready");
        const before = sessionToken();
        const file = readFileSync(credentialsFile(home), "utf8");
        expect(await refusal(rotateSession(home, osFileLock))).toBeInstanceOf(ServiceRunning);
        expect(sessionToken()).toBe(before);
        expect(readFileSync(credentialsFile(home), "utf8")).toBe(file);
      } finally {
        await s.stop();
        seen.push(...lines);
      }
      expect(lines.length).toBeGreaterThan(0);
      await open();
    },
    T,
  );

  it(
    "with the service stopped: the old token stops working, the new one works, after a restart too",
    async () => {
      const old = sessionToken();
      await close();
      await rotateSession(home, osFileLock);
      await open();
      const fresh = sessionToken();
      expect(fresh).not.toBe(old);
      expect(await auth(`Bearer ${old}`)).toEqual({ code: "unauthenticated", reason: "invalid" });
      expect(await auth(`Bearer ${fresh}`)).toMatchObject({ kind: "user" });
      await restart();
      expect(await auth(`Bearer ${old}`)).toEqual({ code: "unauthenticated", reason: "invalid" });
      expect(await auth(`Bearer ${fresh}`)).toMatchObject({ kind: "user" });
    },
    T,
  );
});

describe("no token leaks", () => {
  it("no result, refusal, error or log line holds a token", () => {
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.filter((s) => TOKEN.test(s))).toEqual([]);
  });
});
