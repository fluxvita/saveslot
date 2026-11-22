// The credential a local client runs with (docs/zh-CN/spec/06-cli.md §2 «用户会话凭证», §8.2, §8.3).
//
// - `SAVESLOT_TOKEN` set: that connection instance's token, and nothing else. The variable exists
//   so that an agent or a script runs under its own connection, within its scope; a value that is
//   not a connection token is refused rather than passed over for the user session, which can do
//   everything (an empty value included: an unset variable is the only way to the user session).
// - Otherwise the user session token in `<home>/credentials/session`, read only when the home and
//   `credentials/` are directories and the file a regular file, all of this user's, none open to
//   group or others (06 §2: refused like ssh refuses a private key), and the file not a symbolic
//   link. The file is opened without following a link and without blocking (a FIFO would block
//   the open), and the checks are made on the open descriptor: for the file, what was checked is
//   what is read.
//   The two directories are checked by path, with lstat: the path given is not a link, but a link
//   further up it is followed, and a path ending in `/` or `/.` names what the link points to.
//   Exploiting that takes writing into a 0700 home of this user, which is outside what this
//   check guards against (06 §8.3).
//
// A token never goes into an error message.

import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

export type CredentialKind = "session" | "connection";

export interface Credential {
  readonly kind: CredentialKind;
  readonly token: string;
}

/**
 * Why there is no credential to use.
 * - `not_initialized`: no session file (and no `SAVESLOT_TOKEN`).
 * - `permissions`: the home, `credentials/` or the file is not this user's, is a link, is not of
 *   its kind, is open to group or others, or cannot be read by this user.
 * - `malformed`: the session file, `SAVESLOT_TOKEN`, `profiles.json` or a profile's credentials
 *   file does not hold what its form says.
 * - `unknown_profile`: a profile neither built in nor registered (./profiles.ts).
 * - `signed_out`: a server profile without its credentials file: `saveslot login` first.
 * - `server_mismatch`: the credentials file is for another server than the profile's: nothing is
 *   sent; `saveslot login` again.
 * - `refresh_refused`: the server refused the refresh token (`invalid_grant`): signed out.
 * - `refresh_unsaved`: a refresh answered, and its new tokens could not be written: the old refresh
 *   token is spent, so this sign-in is over; the new tokens are not used (./profile-credentials.ts).
 * - `busy`: another saveslot command held the profile's lock for longer than the wait.
 */
export class CredentialError extends Error {
  override readonly name = "CredentialError";
  readonly code:
    | "not_initialized"
    | "permissions"
    | "malformed"
    | "unknown_profile"
    | "signed_out"
    | "server_mismatch"
    | "refresh_refused"
    | "refresh_unsaved"
    | "busy";
  /** The path concerned; absent for `SAVESLOT_TOKEN`. */
  readonly path: string | undefined;
  constructor(code: CredentialError["code"], message: string, path?: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

/** The environment variable of a connection instance's token (06-cli §2). */
export const TOKEN_VARIABLE = "SAVESLOT_TOKEN";

/** The forms of the two local tokens: prefix and 43 base64url characters (04-contract §12). */
const SESSION_FORM = /^sls_[A-Za-z0-9_-]{43}$/;
export const CONNECTION_FORM = /^slt_[A-Za-z0-9_-]{43}$/;

/** The session token's file under a home. */
export const sessionFile = (home: string): string => join(home, "credentials", "session");

/** At most this many bytes are read from the session file. */
const MAX_FILE_BYTES = 4096;

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

function check(path: string, s: Stats, kind: "directory" | "file"): void {
  if (s.isSymbolicLink()) {
    throw new CredentialError("permissions", `${path} is a symbolic link`, path);
  }
  if (kind === "directory" ? !s.isDirectory() : !s.isFile()) {
    throw new CredentialError("permissions", `${path} is not a ${kind}`, path);
  }
  const owner = uid();
  if (owner !== undefined && s.uid !== owner) {
    throw new CredentialError("permissions", `${path} is not owned by the current user`, path);
  }
  if ((s.mode & 0o077) !== 0) {
    const want = kind === "directory" ? "700" : "600";
    throw new CredentialError(
      "permissions",
      `${path} has mode ${(s.mode & 0o777).toString(8)}, open to others; run chmod ${want} ${path}`,
      path,
    );
  }
}

async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    unreadable(e, path);
  }
}

/** EACCES and EPERM as the `permissions` refusal; anything else rethrown. */
function unreadable(e: unknown, path: string): never {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    throw new CredentialError("permissions", `${path} cannot be read by the current user`, path);
  }
  throw e;
}

/** Reads the user session token of `home`, checked as the header says. */
export async function readSessionToken(home: string): Promise<string> {
  const credentialsDir = join(home, "credentials");
  const file = sessionFile(home);
  for (const [path, kind] of [
    [home, "directory"],
    [credentialsDir, "directory"],
  ] as const) {
    const s = await lstatOrMissing(path);
    if (s === undefined) {
      throw new CredentialError(
        "not_initialized",
        `${path} does not exist; run saveslot init`,
        path,
      );
    }
    check(path, s, kind);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CredentialError(
        "not_initialized",
        `${file} does not exist; run saveslot init`,
        file,
      );
    }
    // O_NOFOLLOW on a link: ELOOP (Linux, macOS) or EMLINK (FreeBSD).
    if (code === "ELOOP" || code === "EMLINK") {
      throw new CredentialError("permissions", `${file} is a symbolic link`, file);
    }
    unreadable(e, file);
  }
  try {
    check(file, await handle.stat(), "file");
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    // The file holds the token alone; one line end after it is tolerated.
    const token = text.endsWith("\n") ? text.slice(0, -1) : text;
    if (bytesRead > MAX_FILE_BYTES || !SESSION_FORM.test(token)) {
      throw new CredentialError("malformed", `${file} does not hold a session token`, file);
    }
    return token;
  } finally {
    await handle.close();
  }
}

/**
 * The credential to run with: `SAVESLOT_TOKEN` of `env` when the variable is set at all, otherwise
 * the user session of `home`.
 */
export async function resolveCredential(o: {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<Credential> {
  if (Object.hasOwn(o.env, TOKEN_VARIABLE) && o.env[TOKEN_VARIABLE] !== undefined) {
    const token = o.env[TOKEN_VARIABLE];
    if (!CONNECTION_FORM.test(token)) {
      throw new CredentialError(
        "malformed",
        `${TOKEN_VARIABLE} is set but does not hold a connection token; unset it to run as the user session`,
      );
    }
    return { kind: "connection", token };
  }
  return { kind: "session", token: await readSessionToken(o.home) };
}
