// A server profile's user session (06-cli §2 «用户会话凭证»): `credentials/<profile>.json`,
// written by `saveslot login`, read by every command run with that profile, removed by
// `saveslot logout`. The `local` profile has `credentials/session` instead (./credentials.ts).
//
// {"format": 1, "server": "<origin>", "access_token": "sls_…", "access_expires_at": "<instant>",
//  "refresh_token": "slr_…"}
//
// - Parsed strictly: those five keys and no other. `server` is the server the tokens were issued
//   for; it must be the profile's server to the character, or no token is sent anywhere.
// - A refresh token is good once: a second use voids the whole sign-in (05-surfaces §15). So a
//   refresh happens only under the profile's lock (`<profile>.json.lock`, exclusive), with the
//   file read again under it: another command may have refreshed meanwhile, and then its tokens
//   are used. A refresh's answer is written before its access token is used; when that write
//   fails the sign-in is over (the old refresh token is spent), and the new tokens are dropped
//   rather than used once and lost.
// - A request made holding the lock ends within LOCKED_REQUEST_MS: a lock held longer than
//   LOCK_STALE_MS is taken by the next command, which would then use the same refresh token.
// - Tokens are in no error message.

import { constants } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  CONNECTION_FORM,
  CredentialError,
  readSessionToken,
  TOKEN_VARIABLE,
} from "./credentials.ts";
import {
  privateDirectories,
  readPrivateFile,
  removePrivateFile,
  writePrivateFile,
} from "./private-files.ts";
import { PROFILE_NAME, profileServer, readProfiles } from "./profiles.ts";
import {
  ClientUsageError,
  OAuthError,
  oauthPost,
  serverOrigin,
  TransportError,
} from "./transport.ts";

/** The CLI's client ID at a server's authorization server: a public client (05-surfaces §15). */
export const CLI_CLIENT_ID = "saveslot-cli";

const ACCESS_FORM = /^sls_[A-Za-z0-9_-]{43}$/;
const REFRESH_FORM = /^slr_[A-Za-z0-9_-]{43}$/;

/** Refreshed when the access token has at most this long left. */
export const REFRESH_MARGIN_MS = 60_000;
/** A lock older than this is taken as left by a command that died. */
export const LOCK_STALE_MS = 30_000;
/** How long a command waits for another's lock. */
export const LOCK_WAIT_MS = 10_000;
/**
 * The longest a request made holding the profile's lock may take (06-cli §2). With
 * LOCKED_WORK_MARGIN_MS for the rest of what is done holding it (reading the file again, writing
 * the new pair: a temporary file, fsync, rename, the directory's fsync), it stays within
 * LOCK_STALE_MS: `LOCKED_REQUEST_MS + LOCKED_WORK_MARGIN_MS <= LOCK_STALE_MS`, pinned by a test.
 */
export const LOCKED_REQUEST_MS = 20_000;
export const LOCKED_WORK_MARGIN_MS = 10_000;

/** A request's time limit holding the lock: the caller's when shorter, never longer than `bound`. */
export const lockedTimeout = (asked: number | undefined, bound = LOCKED_REQUEST_MS): number =>
  asked === undefined ? bound : Math.min(asked, bound);

export interface ProfileCredentials {
  readonly server: string;
  readonly access_token: string;
  /** A canonical instant (`toISOString()`). */
  readonly access_expires_at: string;
  readonly refresh_token: string;
}

const MAX_FILE_BYTES = 4096;

function profileName(profile: string): string {
  if (!PROFILE_NAME.test(profile) || profile === "local") {
    throw new ClientUsageError(`${profile} is not a server profile's name`);
  }
  return profile;
}

const credentialsDir = (home: string) => join(home, "credentials");
const fileName = (profile: string) => `${profileName(profile)}.json`;
/** A profile's credentials file under a home. */
export const profileCredentialsFile = (home: string, profile: string): string =>
  join(credentialsDir(home), fileName(profile));

const instant = (v: unknown): v is string =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;

/** Whether `c` is a whole credentials object of the form; with `server`, an origin as written. */
function valid(c: unknown): c is ProfileCredentials {
  if (c === null || typeof c !== "object" || Array.isArray(c)) return false;
  const o = c as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "access_expires_at,access_token,refresh_token,server") {
    return false;
  }
  let origin: string | undefined;
  try {
    origin = serverOrigin(o["server"]).origin;
  } catch {
    return false;
  }
  return (
    origin === o["server"] &&
    typeof o["access_token"] === "string" &&
    ACCESS_FORM.test(o["access_token"]) &&
    typeof o["refresh_token"] === "string" &&
    REFRESH_FORM.test(o["refresh_token"]) &&
    instant(o["access_expires_at"])
  );
}

/** Reads a profile's credentials; undefined when there are none (signed out). */
export async function readProfileCredentials(
  home: string,
  profile: string,
): Promise<ProfileCredentials | undefined> {
  const file = profileCredentialsFile(home, profile);
  const text = await readPrivateFile([home, credentialsDir(home)], file, MAX_FILE_BYTES);
  if (text === undefined) return undefined;
  const bad = () =>
    new CredentialError(
      "malformed",
      `${file} is not a credentials file of this version; run saveslot login --profile ${profile}`,
      file,
    );
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad();
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad();
  const { format, ...rest } = v as Record<string, unknown>;
  if (format !== 1 || !valid(rest)) throw bad();
  return rest;
}

/** Writes a profile's credentials (`saveslot login`, a refresh), atomically, 0600. */
export async function writeProfileCredentials(
  home: string,
  profile: string,
  c: ProfileCredentials,
): Promise<void> {
  if (!valid(c)) throw new ClientUsageError("not credentials of the form");
  const { server, access_token, access_expires_at, refresh_token } = c;
  const text = `${JSON.stringify(
    { format: 1, server, access_token, access_expires_at, refresh_token },
    null,
    2,
  )}\n`;
  await writePrivateFile([home, credentialsDir(home)], fileName(profile), text);
}

/** Removes a profile's credentials (`saveslot logout`); false when there were none. */
export async function removeProfileCredentials(home: string, profile: string): Promise<boolean> {
  return removePrivateFile(credentialsDir(home), fileName(profile));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs `fn` holding the profile's lock: `credentials/<profile>.json.lock`, created exclusively at
 * 0600 with this process's ID and the time. A lock older than LOCK_STALE_MS is removed and taken;
 * a held one is waited for up to LOCK_WAIT_MS, then `busy`. Released after `fn`, whatever it did,
 * if it is still this one's.
 */
export async function withProfileLock<T>(
  home: string,
  profile: string,
  fn: () => Promise<T>,
  o: { readonly waitMs?: number; readonly staleMs?: number } = {},
): Promise<T> {
  await privateDirectories([home, credentialsDir(home)]);
  const lock = `${profileCredentialsFile(home, profile)}.lock`;
  const mine = `${process.pid} ${new Date().toISOString()} ${Math.random()}\n`;
  const until = Date.now() + (o.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      const h = await open(
        lock,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await h.writeFile(mine, "utf8");
      } finally {
        await h.close();
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const s = await lstat(lock).catch(() => undefined);
    if (s !== undefined && Date.now() - s.mtimeMs > (o.staleMs ?? LOCK_STALE_MS)) {
      await unlink(lock).catch(() => {});
      continue;
    }
    if (Date.now() >= until) {
      throw new CredentialError(
        "busy",
        `another saveslot command is signing in to profile ${profile}; try again`,
        lock,
      );
    }
    await sleep(50);
  }
  try {
    return await fn();
  } finally {
    if ((await readFile(lock, "utf8").catch(() => "")) === mine) await unlink(lock).catch(() => {});
  }
}

const fresh = (c: ProfileCredentials, now: number) =>
  Date.parse(c.access_expires_at) - now > REFRESH_MARGIN_MS;

/** The credentials, or why not: none, or for another server (nothing is sent then). */
async function mine(home: string, profile: string, server: string): Promise<ProfileCredentials> {
  const c = await readProfileCredentials(home, profile);
  if (c === undefined) {
    throw new CredentialError(
      "signed_out",
      `not signed in to profile ${profile}; run saveslot login --profile ${profile}`,
    );
  }
  if (c.server !== server) {
    throw new CredentialError(
      "server_mismatch",
      `the sign-in of profile ${profile} is for another server; run saveslot login --profile ${profile}`,
      profileCredentialsFile(home, profile),
    );
  }
  return c;
}

/**
 * The profile's access token, refreshed first when it has REFRESH_MARGIN_MS or less left, or when
 * it is `rejected` (the token a request was just refused with, `unauthenticated`). Under the lock
 * the file is read again: a token another command put there meanwhile is used as it is.
 * - The server refuses the refresh token (`invalid_grant`): `refresh_refused`; the file is kept
 *   (only `logout` removes it).
 * - The new tokens cannot be written: `refresh_unsaved`; they are not used.
 * - The server not reachable, or its answer no OAuth answer: the TransportError as it came.
 * - `timeoutMs` only shortens the token request's limit: it holds the lock, so it ends within
 *   LOCKED_REQUEST_MS whatever is asked; a request out of time is a TransportError, the file kept.
 */
export async function refreshProfile(
  home: string,
  profile: string,
  server: string,
  o: {
    readonly rejected?: string;
    readonly now?: () => number;
    readonly timeoutMs?: number;
    /** Tests only: LOCKED_REQUEST_MS replaced. */
    readonly testing?: { readonly lockedRequestMs?: number };
  } = {},
): Promise<string> {
  const now = o.now ?? Date.now;
  const usable = (c: ProfileCredentials) => c.access_token !== o.rejected && fresh(c, now());
  const before = await mine(home, profile, server);
  if (usable(before)) return before.access_token;
  return withProfileLock(home, profile, async () => {
    const c = await mine(home, profile, server);
    if (usable(c)) return c.access_token;
    let answer: Record<string, unknown> | undefined;
    try {
      answer = await oauthPost({
        server,
        path: "/oauth/token",
        form: new Map([
          ["grant_type", "refresh_token"],
          ["refresh_token", c.refresh_token],
          ["client_id", CLI_CLIENT_ID],
        ]),
        timeoutMs: lockedTimeout(o.timeoutMs, o.testing?.lockedRequestMs),
      });
    } catch (e) {
      if (e instanceof OAuthError && e.code === "invalid_grant") {
        throw new CredentialError(
          "refresh_refused",
          `the sign-in of profile ${profile} has ended; run saveslot login --profile ${profile}`,
        );
      }
      throw e;
    }
    const received = now();
    const a = answer ?? {};
    const expiresIn = a["expires_in"];
    if (
      typeof a["access_token"] !== "string" ||
      !ACCESS_FORM.test(a["access_token"]) ||
      typeof a["refresh_token"] !== "string" ||
      !REFRESH_FORM.test(a["refresh_token"]) ||
      typeof expiresIn !== "number" ||
      !Number.isInteger(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new TransportError("bad_answer", "the refresh's answer is not of its form", 200);
    }
    const next: ProfileCredentials = {
      server,
      access_token: a["access_token"],
      access_expires_at: new Date(received + expiresIn * 1000).toISOString(),
      refresh_token: a["refresh_token"],
    };
    try {
      await writeProfileCredentials(home, profile, next);
    } catch {
      throw new CredentialError(
        "refresh_unsaved",
        `the new sign-in of profile ${profile} could not be saved in ${profileCredentialsFile(home, profile)}; run saveslot login --profile ${profile}`,
        profileCredentialsFile(home, profile),
      );
    }
    return next.access_token;
  });
}

/** What a command runs with: a token, and the server it goes to (none: the local service). */
export interface ProfileCredential {
  readonly kind: "session" | "connection";
  readonly token: string;
  /** The profile's server; undefined for `local`, the local service's socket. */
  readonly server: string | undefined;
  readonly profile: string;
}

/**
 * The credential of profile `profile` (the one in use when not given). `SAVESLOT_TOKEN` set at
 * all: that connection token, sent to the selected profile's server (or the local service for
 * `local`), never the user session. Otherwise the user session: `credentials/session` for
 * `local`, the profile's sign-in for a server, refreshed when due (`refreshProfile`).
 */
export async function resolveProfileCredential(o: {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly profile?: string;
  readonly rejected?: string;
}): Promise<ProfileCredential> {
  const profile = o.profile ?? (await readProfiles(o.home)).current;
  const server = await profileServer(o.home, profile);
  if (Object.hasOwn(o.env, TOKEN_VARIABLE) && o.env[TOKEN_VARIABLE] !== undefined) {
    const token = o.env[TOKEN_VARIABLE];
    if (!CONNECTION_FORM.test(token)) {
      throw new CredentialError(
        "malformed",
        `${TOKEN_VARIABLE} is set but does not hold a connection token; unset it to run as the user session`,
      );
    }
    return { kind: "connection", token, server, profile };
  }
  if (server === undefined) {
    return { kind: "session", token: await readSessionToken(o.home), server, profile };
  }
  const token = await refreshProfile(o.home, profile, server, {
    ...(o.rejected !== undefined ? { rejected: o.rejected } : {}),
  });
  return { kind: "session", token, server, profile };
}
