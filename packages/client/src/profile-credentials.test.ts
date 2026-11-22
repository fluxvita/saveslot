// A server profile's credentials file (06-cli §2 «用户会话凭证»): the strict parse, its privacy,
// the refresh against a stand-in token endpoint on loopback, and the lock that keeps a refresh
// token from being used twice.

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialError, sessionFile } from "./credentials.ts";
import {
  CLI_CLIENT_ID,
  LOCK_STALE_MS,
  LOCKED_REQUEST_MS,
  LOCKED_WORK_MARGIN_MS,
  type ProfileCredentials,
  profileCredentialsFile,
  readProfileCredentials,
  refreshProfile,
  removeProfileCredentials,
  resolveProfileCredential,
  withProfileLock,
  writeProfileCredentials,
} from "./profile-credentials.ts";
import { addProfile, CLOUD_SERVER, useProfile } from "./profiles.ts";
import { ClientUsageError, TransportError } from "./transport.ts";

const CHILD = fileURLToPath(new URL("./refresh-child.fixture.ts", import.meta.url));
const tok = (prefix: string, c: string) => `${prefix}_${c.repeat(43)}`;
const OLD_ACCESS = tok("sls", "a");
const OLD_REFRESH = tok("slr", "r");
const NEW_ACCESS = tok("sls", "n");
const NEW_REFRESH = tok("slr", "s");

let root: string;
let home: string;
let server: Server | undefined;
let origin = "";
let posts: URLSearchParams[] = [];
let answer: (res: ServerResponse) => void;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "saveslot-profile-cred-"));
  home = join(root, "home");
  posts = [];
  answer = (res) =>
    json(res, 200, {
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
      token_type: "Bearer",
      expires_in: 900,
    });
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/oauth/token") {
        posts.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
        answer(res);
        return;
      }
      json(res, 404, { error: "not_found" });
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await addProfile(home, "lab", origin);
});
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  // A case may leave credentials/ unwritable: made writable again so that it can be removed.
  if (existsSync(join(home, "credentials"))) chmodSync(join(home, "credentials"), 0o700);
  rmSync(root, { recursive: true, force: true });
});

const json = (res: ServerResponse, status: number, v: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(v));
};

const signedIn = (o: Partial<ProfileCredentials> = {}): ProfileCredentials => ({
  server: origin,
  access_token: OLD_ACCESS,
  access_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  refresh_token: OLD_REFRESH,
  ...o,
});
const due = () => signedIn({ access_expires_at: new Date(Date.now() + 30_000).toISOString() });

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    expect(String((e as Error).message)).not.toMatch(/sls_|slr_|slt_/);
    return e;
  }
  throw new Error("not refused");
}

describe("the credentials file", () => {
  it("written and read back as it was; none: undefined; removed", async () => {
    expect(await readProfileCredentials(home, "lab")).toBeUndefined();
    const c = signedIn();
    await writeProfileCredentials(home, "lab", c);
    expect(await readProfileCredentials(home, "lab")).toEqual(c);
    const text = JSON.parse(readFileSync(profileCredentialsFile(home, "lab"), "utf8"));
    expect(Object.keys(text)).toEqual([
      "format",
      "server",
      "access_token",
      "access_expires_at",
      "refresh_token",
    ]);
    expect(await removeProfileCredentials(home, "lab")).toBe(true);
    expect(await removeProfileCredentials(home, "lab")).toBe(false);
  });

  it("not of the form: malformed, whatever is wrong", async () => {
    await writeProfileCredentials(home, "lab", signedIn());
    const good = JSON.parse(readFileSync(profileCredentialsFile(home, "lab"), "utf8"));
    for (const [what, v] of [
      ["another key", { ...good, user: "u" }],
      ["a key missing", { ...good, refresh_token: undefined }],
      ["format 2", { ...good, format: 2 }],
      ["an access token of another form", { ...good, access_token: "sls_short" }],
      ["a refresh token of another form", { ...good, refresh_token: OLD_ACCESS }],
      ["an instant not canonical", { ...good, access_expires_at: "2026-11-21T09:00:00Z" }],
      ["a server with a path", { ...good, server: `${origin}/v1` }],
    ] as const) {
      writeFileSync(profileCredentialsFile(home, "lab"), JSON.stringify(v), { mode: 0o600 });
      expect([what, await refusal(readProfileCredentials(home, "lab"))]).toEqual([
        what,
        expect.objectContaining({ code: "malformed" }),
      ]);
    }
  });

  it("open to others, a directory open to others, a link: permissions", async () => {
    await writeProfileCredentials(home, "lab", signedIn());
    const file = profileCredentialsFile(home, "lab");
    chmodSync(file, 0o644);
    expect(await refusal(readProfileCredentials(home, "lab"))).toMatchObject({
      code: "permissions",
    });
    chmodSync(file, 0o600);
    chmodSync(join(home, "credentials"), 0o755);
    expect(await refusal(readProfileCredentials(home, "lab"))).toMatchObject({
      code: "permissions",
    });
    chmodSync(join(home, "credentials"), 0o700);
    rmSync(file);
    writeFileSync(join(root, "elsewhere.json"), "{}", { mode: 0o600 });
    symlinkSync(join(root, "elsewhere.json"), file);
    expect(await refusal(readProfileCredentials(home, "lab"))).toMatchObject({
      code: "permissions",
    });
  });

  it("a profile's name checked before it makes a path: local and names not of the form refused", async () => {
    for (const name of ["local", "../lab", "Lab", ""]) {
      expect([name, await refusal(readProfileCredentials(home, name))]).toEqual([
        name,
        expect.any(ClientUsageError),
      ]);
    }
  });
});

describe("refreshProfile", () => {
  it("a token with more than a minute left: used, nothing sent", async () => {
    await writeProfileCredentials(home, "lab", signedIn());
    expect(await refreshProfile(home, "lab", origin)).toBe(OLD_ACCESS);
    expect(posts).toEqual([]);
  });

  it("due: the refresh token posted with the CLI's client ID; the new pair written, then used", async () => {
    await writeProfileCredentials(home, "lab", due());
    const before = Date.now();
    expect(await refreshProfile(home, "lab", origin)).toBe(NEW_ACCESS);
    expect(posts.map((p) => Object.fromEntries(p))).toEqual([
      { grant_type: "refresh_token", refresh_token: OLD_REFRESH, client_id: CLI_CLIENT_ID },
    ]);
    expect(CLI_CLIENT_ID).toBe("saveslot-cli");
    const now = await readProfileCredentials(home, "lab");
    expect(now).toMatchObject({
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
      server: origin,
    });
    const expires = Date.parse(now?.access_expires_at ?? "");
    expect(expires).toBeGreaterThanOrEqual(before + 900_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 900_000);
  });

  it("the token a request was refused with: refreshed though not due", async () => {
    await writeProfileCredentials(home, "lab", signedIn());
    expect(await refreshProfile(home, "lab", origin, { rejected: OLD_ACCESS })).toBe(NEW_ACCESS);
    expect(posts).toHaveLength(1);
  });

  it("the sign-in is for another server: server_mismatch, nothing sent", async () => {
    await writeProfileCredentials(home, "lab", { ...due(), server: "https://other.example" });
    expect(await refusal(refreshProfile(home, "lab", origin))).toMatchObject({
      code: "server_mismatch",
    });
    expect(posts).toEqual([]);
  });

  it("not signed in: signed_out", async () => {
    expect(await refusal(refreshProfile(home, "lab", origin))).toMatchObject({
      code: "signed_out",
    });
  });

  it("invalid_grant: refresh_refused, and the file kept as it was", async () => {
    answer = (res) => json(res, 400, { error: "invalid_grant", error_description: "x" });
    await writeProfileCredentials(home, "lab", due());
    const text = readFileSync(profileCredentialsFile(home, "lab"), "utf8");
    const e = await refusal(refreshProfile(home, "lab", origin));
    expect(e).toBeInstanceOf(CredentialError);
    expect(e).toMatchObject({ code: "refresh_refused" });
    expect(readFileSync(profileCredentialsFile(home, "lab"), "utf8")).toBe(text);
  });

  it("an answer not of the form: bad_answer, the file kept", async () => {
    answer = (res) => json(res, 200, { access_token: NEW_ACCESS, expires_in: 900 });
    await writeProfileCredentials(home, "lab", due());
    expect(await refusal(refreshProfile(home, "lab", origin))).toEqual(expect.any(TransportError));
    expect((await readProfileCredentials(home, "lab"))?.refresh_token).toBe(OLD_REFRESH);
  });

  it("the new pair cannot be written: refresh_unsaved, and the new token is not used", async () => {
    await writeProfileCredentials(home, "lab", due());
    const dir = join(home, "credentials");
    answer = (res) => {
      // The directory turns unwritable after the lock is taken: the rename fails.
      chmodSync(dir, 0o500);
      json(res, 200, { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 900 });
    };
    const e = await refusal(refreshProfile(home, "lab", origin));
    chmodSync(dir, 0o700);
    expect(e).toMatchObject({ code: "refresh_unsaved" });
    expect((await readProfileCredentials(home, "lab"))?.access_token).toBe(OLD_ACCESS);
  });

  it("a server that never answers: given up within the lock's bound, however long the caller asked; the file kept, the lock released", async () => {
    answer = () => {};
    await writeProfileCredentials(home, "lab", due());
    const text = readFileSync(profileCredentialsFile(home, "lab"), "utf8");
    const started = Date.now();
    const e = await refusal(
      refreshProfile(home, "lab", origin, { timeoutMs: 60_000, testing: { lockedRequestMs: 300 } }),
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(e).toBeInstanceOf(TransportError);
    expect(e).toMatchObject({ code: "broken" });
    expect(posts).toHaveLength(1);
    expect(readFileSync(profileCredentialsFile(home, "lab"), "utf8")).toBe(text);
    expect(existsSync(`${profileCredentialsFile(home, "lab")}.lock`)).toBe(false);
  });

  it("a shorter limit asked by the caller: kept", async () => {
    answer = () => {};
    await writeProfileCredentials(home, "lab", due());
    const started = Date.now();
    const e = await refusal(
      refreshProfile(home, "lab", origin, { timeoutMs: 300, testing: { lockedRequestMs: 60_000 } }),
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(e).toMatchObject({ code: "broken" });
  });

  it("two commands due at once: one refresh, and both end with its token", async () => {
    await writeProfileCredentials(home, "lab", due());
    answer = (res) =>
      setTimeout(
        () =>
          json(res, 200, { access_token: NEW_ACCESS, refresh_token: NEW_REFRESH, expires_in: 900 }),
        300,
      );
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const p = spawn(process.execPath, ["--conditions=source", CHILD, home, "lab", origin], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        p.stdout.on("data", (c: Buffer) => {
          out += c.toString("utf8");
        });
        p.on("error", reject);
        p.on("close", () => resolve(out.trim()));
      });
    expect(await Promise.all([run(), run()])).toEqual([NEW_ACCESS, NEW_ACCESS]);
    expect(posts).toHaveLength(1);
  }, 30_000);
});

describe("withProfileLock", () => {
  it("a request holding it, with the rest done holding it, ends before it counts as left", () => {
    // Raising LOCKED_REQUEST_MS alone, or shrinking the margin below the file work's, fails here.
    expect(LOCKED_REQUEST_MS + LOCKED_WORK_MARGIN_MS).toBeLessThanOrEqual(LOCK_STALE_MS);
    expect(LOCKED_WORK_MARGIN_MS).toBeGreaterThanOrEqual(10_000);
  });

  it("held by another: waited for, then busy", async () => {
    await writeProfileCredentials(home, "lab", signedIn());
    writeFileSync(`${profileCredentialsFile(home, "lab")}.lock`, "1 x\n", { mode: 0o600 });
    const e = await refusal(withProfileLock(home, "lab", async () => 1, { waitMs: 200 }));
    expect(e).toMatchObject({ code: "busy" });
  });

  it("left by a command that died (older than the stale limit): taken, and released after", async () => {
    await writeProfileCredentials(home, "lab", signedIn());
    const lock = `${profileCredentialsFile(home, "lab")}.lock`;
    writeFileSync(lock, "1 x\n", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(await withProfileLock(home, "lab", async () => "ran", { waitMs: 200 })).toBe("ran");
    expect(() => readFileSync(lock)).toThrow();
  });
});

describe("resolveProfileCredential", () => {
  it("the profile in use; SAVESLOT_TOKEN sent to the selected profile's server", async () => {
    const connection = tok("slt", "c");
    await useProfile(home, "lab");
    expect(await resolveProfileCredential({ home, env: { SAVESLOT_TOKEN: connection } })).toEqual({
      kind: "connection",
      token: connection,
      server: origin,
      profile: "lab",
    });
    expect(
      await resolveProfileCredential({
        home,
        env: { SAVESLOT_TOKEN: connection },
        profile: "cloud",
      }),
    ).toMatchObject({ server: CLOUD_SERVER });
  });

  it("a server profile: its sign-in; local: the session file; an unknown one: unknown_profile", async () => {
    await writeProfileCredentials(home, "lab", signedIn());
    expect(await resolveProfileCredential({ home, env: {}, profile: "lab" })).toEqual({
      kind: "session",
      token: OLD_ACCESS,
      server: origin,
      profile: "lab",
    });
    const session = tok("sls", "l");
    writeFileSync(sessionFile(home), session, { mode: 0o600 });
    expect(await resolveProfileCredential({ home, env: {}, profile: "local" })).toEqual({
      kind: "session",
      token: session,
      server: undefined,
      profile: "local",
    });
    expect(
      await refusal(resolveProfileCredential({ home, env: {}, profile: "nowhere" })),
    ).toMatchObject({ code: "unknown_profile" });
  });
});
