// The credential a local client runs with (06-cli §2, §8.2): SAVESLOT_TOKEN or the session file,
// each refusal, and no token in any message.

import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialError, resolveCredential, sessionFile } from "./credentials.ts";

/** Running as root, whom the permission bits do not bind (see the cases that use it). */
const AS_ROOT = process.getuid?.() === 0;

// A hook run right after the session file is opened, to change what is at its path then.
const hooks = vi.hoisted(() => ({ afterOpen: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...a: Parameters<typeof real.open>) => {
      const handle = await real.open(...a);
      await hooks.afterOpen?.();
      return handle;
    },
  };
});

const SESSION = `sls_${"a".repeat(43)}`;
const CONNECTION = `slt_${"b".repeat(43)}`;

let root: string;
let home: string;

/** A home as `saveslot init` leaves it: 0700 directories, the session file 0600. */
async function initHome(text = SESSION): Promise<void> {
  await mkdir(join(home, "credentials"), { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await writeFile(sessionFile(home), text, { mode: 0o600 });
}

async function refusal(env: Record<string, string | undefined> = {}) {
  try {
    await resolveCredential({ home, env });
  } catch (e) {
    if (!(e instanceof CredentialError)) throw e;
    for (const t of [SESSION, CONNECTION, "sls_", "slt_"]) expect(e.message).not.toContain(t);
    return e.code;
  }
  throw new Error("not refused");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "saveslot-client-cred-"));
  home = join(root, "home");
});
afterEach(async () => {
  hooks.afterOpen = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("SAVESLOT_TOKEN", () => {
  it("is the credential when set, the session file not read", async () => {
    expect(await resolveCredential({ home, env: { SAVESLOT_TOKEN: CONNECTION } })).toEqual({
      kind: "connection",
      token: CONNECTION,
    });
  });

  it.each([
    ["empty", ""],
    ["a session token", SESSION],
    ["with a line end", `${CONNECTION}\n`],
    ["too short", CONNECTION.slice(0, -1)],
    ["with a space", ` ${CONNECTION}`],
  ])("is refused, not passed over for the session, when %s", async (_, value) => {
    await initHome();
    expect(await refusal({ SAVESLOT_TOKEN: value })).toBe("malformed");
  });

  it("left undefined counts as not set", async () => {
    await initHome();
    expect(await resolveCredential({ home, env: { SAVESLOT_TOKEN: undefined } })).toEqual({
      kind: "session",
      token: SESSION,
    });
  });

  it("is looked up as the environment's own key only", async () => {
    await initHome();
    const env = Object.create({ SAVESLOT_TOKEN: CONNECTION }) as Record<string, string>;
    expect((await resolveCredential({ home, env })).kind).toBe("session");
  });
});

describe("the session file", () => {
  it.each([
    ["alone", SESSION],
    ["with one line end", `${SESSION}\n`],
  ])("is read %s", async (_, text) => {
    await initHome(text);
    expect(await resolveCredential({ home, env: {} })).toEqual({ kind: "session", token: SESSION });
  });

  it("is read at a narrower mode (0400)", async () => {
    await initHome();
    await chmod(sessionFile(home), 0o400);
    expect((await resolveCredential({ home, env: {} })).token).toBe(SESSION);
  });

  it.each([
    ["two line ends", `${SESSION}\n\n`],
    ["a connection token", CONNECTION],
    ["nothing", ""],
    ["more than the limit", `${SESSION}${" ".repeat(5000)}`],
  ])("is refused holding %s", async (_, text) => {
    await initHome(text);
    expect(await refusal()).toBe("malformed");
  });

  it("missing, or its home missing: not initialized", async () => {
    expect(await refusal()).toBe("not_initialized");
    await initHome();
    await rm(sessionFile(home));
    expect(await refusal()).toBe("not_initialized");
  });

  it.each([
    ["the file", () => sessionFile(home), 0o644],
    ["the file", () => sessionFile(home), 0o604],
    ["the file", () => sessionFile(home), 0o640],
    ["credentials/", () => join(home, "credentials"), 0o755],
    ["credentials/", () => join(home, "credentials"), 0o701],
    ["the home", () => home, 0o750],
  ])("is refused when %s is open to others (%o)", async (_, path, mode) => {
    await initHome();
    await chmod(path(), mode);
    expect(await refusal()).toBe("permissions");
  });

  it("is refused through a symbolic link: the file, credentials/ or the home", async () => {
    await initHome();
    const elsewhere = join(root, "elsewhere");
    await writeFile(elsewhere, SESSION, { mode: 0o600 });
    await rm(sessionFile(home));
    await symlink(elsewhere, sessionFile(home));
    expect(await refusal()).toBe("permissions");

    const dir = join(root, "dir");
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "session"), SESSION, { mode: 0o600 });
    await rm(join(home, "credentials"), { recursive: true });
    await symlink(dir, join(home, "credentials"));
    expect(await refusal()).toBe("permissions");

    const linkedHome = join(root, "linked-home");
    await symlink(home, linkedHome);
    home = linkedHome;
    expect(await refusal()).toBe("permissions");
  });

  it("is refused when it is a directory", async () => {
    await initHome();
    await rm(sessionFile(home));
    await mkdir(sessionFile(home), { mode: 0o700 });
    expect(await refusal()).toBe("permissions");
  });

  it("is refused, not waited on, when it is a FIFO", async () => {
    await initHome();
    await rm(sessionFile(home));
    execFileSync("mkfifo", ["-m", "600", sessionFile(home)]);
    expect(await refusal()).toBe("permissions");
  });

  // Root reads and searches whatever the mode bits say: these cases are of a user they bind, and
  // are skipped when run as root (as in a container).
  it.skipIf(AS_ROOT).each([0o200, 0o000])(
    "is refused when this user cannot read it (%o)",
    async (mode) => {
      await initHome();
      await chmod(sessionFile(home), mode);
      expect(await refusal()).toBe("permissions");
    },
  );

  it.skipIf(AS_ROOT).each([
    ["credentials/", () => join(home, "credentials")],
    ["the home", () => home],
  ])("is refused when %s cannot be searched (0000)", async (_, dir) => {
    await initHome();
    await chmod(dir(), 0o000);
    try {
      expect(await refusal()).toBe("permissions");
    } finally {
      await chmod(dir(), 0o700);
    }
  });

  it("is refused when it is not this user's", async () => {
    await initHome();
    const uid = process.getuid?.();
    if (uid === undefined) return;
    expect((await resolveCredential({ home, env: {} })).token).toBe(SESSION);
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(await refusal()).toBe("permissions");
  });

  it("is checked on what was opened, not on what is at its path afterwards", async () => {
    await initHome();
    await chmod(sessionFile(home), 0o644);
    const good = join(home, "credentials", "good");
    await writeFile(good, SESSION, { mode: 0o600 });
    hooks.afterOpen = () => rename(good, sessionFile(home));
    expect(await refusal()).toBe("permissions");
  });
});
