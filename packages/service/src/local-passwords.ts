// The local accounts' passwords (docs/zh-CN/spec/02-architecture.md §5): hashed with scrypt, the
// parameters kept with each hash as `scrypt$N$r$p$salt$hash` (base64url salt and hash), so changing
// them later needs no migration. Each computation takes 32 MiB: at most `SCRYPT_AT_ONCE` run at a
// time, a name's dummy included. Internal to the service: not exported from the package.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Tx } from "@fluxvita/saveslot-kernel";
import type { UserId } from "./control-plane.ts";
import type { ControlDb } from "./server-control-plane.ts";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** The scrypt parameters new passwords are hashed with. */
export const SCRYPT = { N: 2 ** 15, r: 8, p: 3, saltBytes: 16, keyBytes: 32 } as const;

/** How many scrypt computations run at once; the rest wait their turn. */
export const SCRYPT_AT_ONCE = 2;

/**
 * How many sign-in checks may wait for a place: one more is refused at once
 * (`PasswordChecksBusy`) rather than queued. At about a tenth of a second a computation, the last
 * of them waits under a second. The deployer's operations are never refused.
 */
export const SCRYPT_WAIT_MAX = 16;

/**
 * How long a sign-in check waits for a place, at most: then it leaves the queue, refused
 * (`PasswordChecksBusy`), and the place it would have had goes to the next. The deployer's
 * operations wait as long as it takes.
 */
export const SCRYPT_WAIT_MS = 2000;

/** A sign-in check refused because too many are already waiting, or it waited too long. */
export class PasswordChecksBusy extends Error {
  override readonly name = "PasswordChecksBusy";
  constructor() {
    super("too many password checks are waiting");
  }
}

/**
 * The parameters a stored hash may name, at most: what one check may cost. A hash outside them, or
 * whose salt or key is not of the right length, matches no password. `SCRYPT` is within them.
 */
export const STORED_MAX = { N: 2 ** 17, r: 16, p: 4 } as const;

/** A name an account can have: lower-case letters, digits, `.`, `_`, `-`; a letter or digit first. */
export const NAME_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The shortest and the longest password taken, in UTF-16 code units, not normalized. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 1024;

let params: { readonly N: number; readonly r: number; readonly p: number } = SCRYPT;

/**
 * Tests only: hashes new passwords with cheaper parameters (each hash still records the ones it was
 * made with); undefined goes back to `SCRYPT`. The dummy hash already made is kept.
 */
export function useScryptForTests(
  p: { readonly N: number; readonly r: number; readonly p: number } | undefined,
): void {
  params = p ?? SCRYPT;
}

let waitMs = SCRYPT_WAIT_MS;

/** Tests only: how long a sign-in check waits for a place; undefined goes back to `SCRYPT_WAIT_MS`. */
export function useScryptWaitForTests(ms: number | undefined): void {
  waitMs = ms ?? SCRYPT_WAIT_MS;
}

/** Tests only: forgets the dummy hash, so the next check without an account makes it again. */
export function resetDummyForTests(): void {
  dummy = undefined;
}

let computations = 0;
let peak = 0;
let refusedFull = 0;
let refusedLate = 0;

/**
 * Tests only: how many computations are running and how many wait their turn; how many were
 * started in all, and the most that ever ran at once; how many sign-in checks were refused, with
 * the queue full and at the time limit.
 */
export function scryptLoadForTests(): {
  readonly running: number;
  readonly waiting: number;
  readonly computations: number;
  readonly peak: number;
  readonly refusedFull: number;
  readonly refusedLate: number;
} {
  return { running, waiting: waiting.length, computations, peak, refusedFull, refusedLate };
}

/** A password's hash with the current parameters, as stored. */
export async function hashPassword(password: string): Promise<string> {
  const { N, r, p } = params;
  if (N > STORED_MAX.N || r > STORED_MAX.r || p > STORED_MAX.p) {
    throw new Error("scrypt parameters outside what a stored hash may name: no check would match");
  }
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await derive(password, salt, N, r, p, SCRYPT.keyBytes);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

const isPowerOfTwo = (n: number) => Number.isSafeInteger(n) && n > 1 && (n & (n - 1)) === 0;

/**
 * Whether `password` is the one `stored` is the hash of, with the parameters stored with it. A hash
 * that is not one this module writes (its key not 32 bytes, its salt under 16, its parameters out
 * of bounds) matches nothing, and costs nothing to find so.
 */
export async function passwordMatches(
  password: string,
  stored: string,
  o: { readonly refuseWhenBusy?: boolean } = {},
): Promise<boolean> {
  const m = /^scrypt\$(\d{1,7})\$(\d{1,3})\$(\d{1,3})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(
    stored,
  );
  if (m === null) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isPowerOfTwo(N) || N > STORED_MAX.N) return false;
  if (r < 1 || r > STORED_MAX.r || p < 1 || p > STORED_MAX.p) return false;
  const salt = Buffer.from(m[4] as string, "base64url");
  const want = Buffer.from(m[5] as string, "base64url");
  if (salt.length < SCRYPT.saltBytes || want.length !== SCRYPT.keyBytes) return false;
  const got = await derive(password, salt, N, r, p, want.length, o.refuseWhenBusy);
  return got.length === want.length && timingSafeEqual(got, want);
}

let running = 0;
const waiting: (() => void)[] = [];

/**
 * A place among the `SCRYPT_AT_ONCE` computations. A place given up goes straight to the first
 * waiting, so a computation arriving in between cannot take it too. A sign-in check is refused
 * when `SCRYPT_WAIT_MAX` already wait, and waits `SCRYPT_WAIT_MS` at most.
 */
async function acquire(refuseWhenBusy = false): Promise<void> {
  if (running < SCRYPT_AT_ONCE) {
    running++;
  } else {
    if (refuseWhenBusy && waiting.length >= SCRYPT_WAIT_MAX) {
      refusedFull++;
      throw new PasswordChecksBusy();
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const turn = () => {
        clearTimeout(timer);
        resolve();
      };
      waiting.push(turn);
      if (refuseWhenBusy) {
        timer = setTimeout(() => {
          // Out of the queue: a place given up from now on goes to the next one waiting. Its turn
          // clears this timer, so the turn is still there; were it given, nothing is done.
          const i = waiting.indexOf(turn);
          if (i < 0) return;
          waiting.splice(i, 1);
          refusedLate++;
          reject(new PasswordChecksBusy());
        }, waitMs);
      }
    });
  }
  peak = Math.max(peak, running);
}

function release(): void {
  const next = waiting.shift();
  if (next === undefined) running--;
  else next();
}

/** Tests only: the places among the computations, taken and given up without computing. */
export const scryptPlacesForTests = { acquire, release } as const;

/** One scrypt computation, at most `SCRYPT_AT_ONCE` at a time; its place given up however it ends. */
async function derive(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keylen: number,
  refuseWhenBusy = false,
): Promise<Buffer> {
  await acquire(refuseWhenBusy);
  computations++;
  try {
    // scrypt needs 128 · N · r bytes; twice that leaves room for its own bookkeeping.
    return await scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r });
  } finally {
    release();
  }
}

let dummy: Promise<string> | undefined;
/**
 * A hash no password is known for: what a name without an account is checked against. Made once,
 * when the local accounts are opened, so that the first check of a name without an account costs
 * no more than any other; a making that fails is not kept, so the next check makes it again.
 */
export function dummyHash(): Promise<string> {
  if (dummy === undefined) {
    const made = hashPassword(randomBytes(32).toString("base64url"));
    dummy = made;
    made.catch(() => {
      if (dummy === made) dummy = undefined;
    });
  }
  return dummy;
}

/**
 * The active account `name` and `password` sign in to; undefined for a name without an account, a
 * name no account can have, a password too long, a wrong password and a disabled account alike.
 * Without an account, the password is checked against `dummyHash` all the same, so the time taken
 * does not say whether the name exists.
 *
 * `passwordHash` is the stored hash the password was compared with: a caller writing something from
 * this sign-in checks, in its own transaction, that the account still has it and is still active
 * (`lockActiveAccount`), so a password changed meanwhile leaves nothing behind. Opaque: never logged
 * or shown.
 */
export async function verifyLocalPassword(
  db: ControlDb,
  name: string,
  password: string,
  /** A sign-in: refused with `PasswordChecksBusy` when too many checks wait. */
  o: { readonly refuseWhenBusy?: boolean } = {},
): Promise<
  { readonly user: UserId; readonly name: string; readonly passwordHash: string } | undefined
> {
  const shaped = NAME_SHAPE.test(name) && password.length <= PASSWORD_MAX;
  const r = shaped
    ? await db.read((tx) =>
        tx.query<{ id: string; password_hash: string; state: string }>(
          "SELECT id, password_hash, state FROM accounts WHERE name = $1",
          [name],
        ),
      )
    : { rows: [] };
  const account = r.rows[0];
  const matches = await passwordMatches(
    shaped ? password : "",
    account?.password_hash ?? (await dummyHash()),
    o,
  );
  if (account === undefined || !matches || account.state !== "active") return undefined;
  return { user: account.id as UserId, name, passwordHash: account.password_hash };
}

/**
 * Whether `user`'s account is active and, when `passwordHash` is given, still has that hash; in the
 * transaction given, with the account's row locked until it ends. A password change or a disable
 * takes the same row first, so it waits for this transaction or this one sees what it wrote.
 */
export async function lockActiveAccount(
  tx: Tx,
  user: UserId,
  passwordHash?: string,
): Promise<boolean> {
  const r = await tx.query<{ password_hash: string; state: string }>(
    "SELECT password_hash, state FROM accounts WHERE id = $1 FOR SHARE",
    [user],
  );
  const row = r.rows[0];
  if (row === undefined || row.state !== "active") return false;
  return passwordHash === undefined || row.password_hash === passwordHash;
}

/**
 * Where `user`'s account stands for a user session, in the transaction given, with the account's
 * row locked until it ends (a password change or a disable takes it first, so it waits for this
 * transaction or this one sees what it wrote): `unknown` without an account, `inactive` when it is
 * not active, `ended` when `grantedAt` is given (a refresh) and a password change last ended its
 * sessions at that instant or after it, else `active`.
 */
export async function lockAccountForSession(
  tx: Tx,
  user: UserId,
  grantedAt?: string,
): Promise<"active" | "inactive" | "unknown" | "ended"> {
  const r = await tx.query<{ state: string; sessions_ended_at: string | null }>(
    "SELECT state, sessions_ended_at FROM accounts WHERE id = $1 FOR SHARE",
    [user],
  );
  const row = r.rows[0];
  if (row === undefined) return "unknown";
  if (row.state !== "active") return "inactive";
  const at = row.sessions_ended_at;
  return grantedAt !== undefined && at != null && at >= grantedAt ? "ended" : "active";
}
