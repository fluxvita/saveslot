// Local credentials without a tenant: tokens and how the Authorization header is read, the
// control files' owner and mode, and `control/credentials.json` read strictly. Fictional IDs.
// Authentication against a tenant, issuing, revoking and init run in the daemon's tests.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ControlFileError,
  checkMode,
  readPrivate,
  removeStaleTemps,
  writePrivate,
} from "./control-files.ts";
import { Credentials, CredentialsCorrupt, credentialsFile } from "./credentials.ts";
import { bearerToken, newToken, sameHash, tokenHash } from "./tokens.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-credentials-"));
// Removing the temporary directory can pass the default 10 s hook time under load.
afterAll(() => rm(root, { recursive: true, force: true }), 60_000);
let n = 0;
/** A home with `control/` at 0700. */
function home(): string {
  const h = join(root, String(n++));
  mkdirSync(join(h, "control"), { recursive: true, mode: 0o700 });
  return h;
}
const CI = `ci_${"5".repeat(26)}`;

describe("tokens", () => {
  it("a prefix and 43 base64url characters, never the same twice", () => {
    const a = newToken("connection");
    const b = newToken("connection");
    expect(a).toMatch(/^slt_[A-Za-z0-9_-]{43}$/);
    expect(newToken("session")).toMatch(/^sls_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(tokenHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads Authorization strictly: Bearer, one space, a token of its form", () => {
    const t = newToken("connection");
    const s = newToken("session");
    expect(bearerToken(`Bearer ${t}`)).toEqual({ kind: "connection", token: t });
    expect(bearerToken(`Bearer ${s}`)).toEqual({ kind: "session", token: s });
    for (const h of [
      undefined,
      "",
      t,
      `bearer ${t}`,
      `Bearer  ${t}`,
      `Bearer ${t} `,
      `Bearer ${t}x`,
      `Bearer ${t.slice(0, -1)}`,
      `Bearer ${t.replace("slt_", "slx_")}`,
      `Bearer ${t.slice(0, -1)}=`,
      `Bearer ${t.slice(0, -1)}+`,
      `Bearer ${t}\n`,
      `Basic ${t}`,
    ]) {
      expect({ h, token: bearerToken(h) }).toEqual({ h, token: undefined });
    }
  });

  it("compares hashes of equal length only", () => {
    const h = tokenHash(newToken("session"));
    expect(sameHash(h, h)).toBe(true);
    expect(sameHash(h, tokenHash(newToken("session")))).toBe(false);
    expect(sameHash(h, h.slice(2))).toBe(false);
    expect(sameHash("", "")).toBe(false);
  });
});

describe("control files", () => {
  it("writes 0600 and reads back; a missing file reads as none", async () => {
    const h = home();
    const f = join(h, "control", "x.json");
    expect(await readPrivate(f)).toBeUndefined();
    writePrivate(f, "{}\n");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(await readPrivate(f)).toBe("{}\n");
  });

  it("refuses a file open to others, and a directory not 0700", async () => {
    const h = home();
    const f = join(h, "control", "x.json");
    writePrivate(f, "{}\n");
    chmodSync(f, 0o644);
    await expect(readPrivate(f)).rejects.toBeInstanceOf(ControlFileError);
    chmodSync(f, 0o600);
    chmodSync(join(h, "control"), 0o755);
    await expect(readPrivate(f)).rejects.toBeInstanceOf(ControlFileError);
    chmodSync(join(h, "control"), 0o700);
    await expect(checkMode(f, 0o600)).resolves.toBeUndefined();
  });
});

describe("control files: links, writes, temporary files", () => {
  it("refuses a link, to a file or to a directory", async () => {
    const h = home();
    const real = join(h, "real.json");
    writeFileSync(real, "{}\n", { mode: 0o600 });
    const link = join(h, "control", "x.json");
    symlinkSync(real, link);
    await expect(readPrivate(link)).rejects.toBeInstanceOf(ControlFileError);
    const dirLink = join(h, "linked");
    symlinkSync(join(h, "control"), dirLink);
    await expect(checkMode(dirLink, 0o700)).rejects.toBeInstanceOf(ControlFileError);
  });

  it("does not write into a directory open to others", () => {
    const h = home();
    chmodSync(join(h, "control"), 0o755);
    expect(() => writePrivate(join(h, "control", "x.json"), "{}\n")).toThrow(ControlFileError);
  });

  it("removes only its own temporary files", () => {
    const h = home();
    const dir = join(h, "control");
    const ours = join(dir, `.saveslot-${"c".repeat(32)}.tmp`);
    writeFileSync(ours, "x", { mode: 0o600 });
    for (const other of ["keep.tmp", ".saveslot-short.tmp", `saveslot-${"c".repeat(32)}.tmp`]) {
      writeFileSync(join(dir, other), "x", { mode: 0o600 });
    }
    expect(removeStaleTemps([dir, join(h, "missing")])).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([
      ".saveslot-short.tmp",
      "keep.tmp",
      `saveslot-${"c".repeat(32)}.tmp`,
    ]);
  });
});

describe("control/credentials.json", () => {
  it("round-trips the session hash and the connection hashes", async () => {
    const h = home();
    const session = tokenHash(newToken("session"));
    const c = Credentials.create(h, session);
    const conn = tokenHash(newToken("connection"));
    c.addConnection(conn, CI as never);
    expect(statSync(credentialsFile(h)).mode & 0o777).toBe(0o600);
    const back = await Credentials.load(h);
    expect(back.sessionHash).toBe(session);
    expect(back.connection(conn)).toBe(CI);
    expect(back.connection(session)).toBeUndefined();
    expect(back.removePrincipals(new Set([CI]))).toBe(1);
    expect((await Credentials.load(h)).connection(conn)).toBeUndefined();
  });

  it("looks a hash up as a key of its own, never a property", async () => {
    const c = Credentials.create(home(), tokenHash(newToken("session")));
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(c.connection(k)).toBeUndefined();
    }
  });

  const hash = "a".repeat(64);
  it.each<[string, string]>([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["another format", JSON.stringify({ format: 2, session: { hash }, connections: [] })],
    ["an extra key", JSON.stringify({ format: 1, session: { hash }, connections: [], x: 1 })],
    [
      "a session hash of another form",
      JSON.stringify({ format: 1, session: { hash: "A" }, connections: [] }),
    ],
    [
      "connections as an object",
      `{"format":1,"session":{"hash":"${hash}"},"connections":{"__proto__":"${CI}"}}`,
    ],
    [
      "a connection of another ID kind",
      JSON.stringify({ format: 1, session: { hash }, connections: [{ hash, principal: "u_x" }] }),
    ],
    [
      "a hash twice",
      JSON.stringify({
        format: 1,
        session: { hash },
        connections: [
          { hash, principal: CI },
          { hash, principal: CI },
        ],
      }),
    ],
  ])("refuses %s", async (_, text) => {
    const h = home();
    writeFileSync(credentialsFile(h), text, { mode: 0o600 });
    await expect(Credentials.load(h)).rejects.toBeInstanceOf(CredentialsCorrupt);
  });

  it("refuses a credentials file open to others", async () => {
    const h = home();
    Credentials.create(h, hash);
    chmodSync(credentialsFile(h), 0o640);
    await expect(Credentials.load(h)).rejects.toBeInstanceOf(ControlFileError);
  });
});
