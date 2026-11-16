// Initializing a local home and rotating its user session (docs/zh-CN/spec/06-cli.md §2 «用户会话凭证»,
// §3 «分步做», §4.1 `saveslot init`): the service-side steps the CLI's `init` runs. Both take the
// home's lock themselves (`run/saveslot.lock`, the lock the service process holds while it runs)
// and refuse with `service_running` when they cannot: a running service keeps the credentials in
// memory and writes them back, so a change behind its back would be undone.
//
// `init` makes the home, `run/`, `control/` and `credentials/` at 0700, the tenant storage with
// its genesis event, the user session token (`credentials/session`, 0600, never printed) with its
// hash in `control/credentials.json`, and last `control/tenant.json`: a home with a tenant
// directory is a home fully initialized. `rotateSession` replaces the session token; the old one
// stops working at once.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createOpsContext,
  createTenant,
  randomCrockford,
  type StorageBackend,
} from "@fluxvita/saveslot-kernel";
import {
  checkMode,
  checkModeIfPresent,
  ensureDir,
  readPrivate,
  removeStaleTemps,
  writePrivate,
} from "./control-files.ts";
import { Credentials, credentialsDir, sessionFile } from "./credentials.ts";
import { controlDir, tenantFile } from "./local-tenant.ts";
import { newToken, tokenHash } from "./tokens.ts";

/** The home's lock: an operating-system lock the service holds while it runs (the daemon's). */
export interface HomeLock {
  /** Takes the lock on `<dir>/saveslot.lock`, or throws (code `store_locked` when it is held). */
  acquire(dir: string): Promise<{ release(): Promise<void> }>;
}

/** Where the home's lock is: `run/`. */
export const homeLockDir = (home: string): string => join(home, "run");

/** `init` on a home that already has a tenant directory. */
export class AlreadyInitialized extends Error {
  override readonly name = "AlreadyInitialized";
  readonly code = "already_initialized";
}

/** The home's lock is held: a saveslot service is running on it. */
export class ServiceRunning extends Error {
  override readonly name = "ServiceRunning";
  readonly code = "service_running";
}

/** Runs `f` holding the home's lock; `service_running` when another holds it. */
async function underHomeLock<T>(home: string, lock: HomeLock, f: () => Promise<T>): Promise<T> {
  await ensureDir(home);
  await mkdir(homeLockDir(home), { recursive: true, mode: 0o700 });
  await checkMode(homeLockDir(home), 0o700);
  let held: { release(): Promise<void> };
  try {
    held = await lock.acquire(homeLockDir(home));
  } catch (e) {
    if ((e as { code?: string }).code === "store_locked") {
      throw new ServiceRunning("a saveslot service is running on this home");
    }
    throw e;
  }
  try {
    removeStaleTemps([controlDir(home), credentialsDir(home)]);
    return await f();
  } finally {
    await held.release();
  }
}

/**
 * Checks a local home's privacy before its credentials are used: the home, `control/` and (when
 * there) `credentials/` are this user's at 0700, the session file (when there) at 0600, none a
 * link. `control/credentials.json` itself is checked when it is read.
 */
export async function checkLocalHome(home: string): Promise<void> {
  await checkMode(home, 0o700);
  await checkMode(controlDir(home), 0o700);
  await checkModeIfPresent(credentialsDir(home), 0o700);
  await checkModeIfPresent(sessionFile(home), 0o600);
}

/** Initializes `home`; the data directory defaults to `<home>/data`. */
export async function initLocalHome(o: {
  readonly home: string;
  readonly dataDir?: string;
  readonly backend: StorageBackend;
  readonly lock: HomeLock;
  readonly now: string;
}): Promise<{ readonly tenant: string; readonly user: string; readonly dataDir: string }> {
  return underHomeLock(o.home, o.lock, async () => {
    await ensureDir(controlDir(o.home));
    await ensureDir(credentialsDir(o.home));
    if ((await readPrivate(tenantFile(o.home))) !== undefined) {
      throw new AlreadyInitialized("the home is initialized already");
    }
    const tenant = `tn_${randomCrockford(26)}`;
    const user = `u_${randomCrockford(26)}`;
    const dataDir = o.dataDir ?? join(o.home, "data");
    const store = await o.backend.open({ kind: "pglite", dir: dataDir }, { create: true });
    try {
      await createTenant(
        store,
        createOpsContext({
          tenant,
          actor: user,
          trigger: null,
          task: null,
          visibility: { kind: "all" },
          idempotency_key_window: 0,
          idempotency_window: 0,
          now: o.now,
          confirmation: null,
        }),
      );
    } finally {
      await store.close();
    }
    const token = newToken("session");
    writePrivate(sessionFile(o.home), `${token}\n`);
    Credentials.create(o.home, tokenHash(token));
    writePrivate(tenantFile(o.home), `${JSON.stringify({ format: 1, user, tenant })}\n`);
    return { tenant, user, dataDir };
  });
}

/** Replaces the user session token of an initialized home whose service is not running. */
export async function rotateSession(home: string, lock: HomeLock): Promise<void> {
  await underHomeLock(home, lock, async () => {
    await checkLocalHome(home);
    const credentials = await Credentials.load(home);
    const token = newToken("session");
    // The hash first: interrupted after it, the session file still holds the old token, which no
    // longer works; rotating again mends it. Never two working sessions.
    credentials.setSession(tokenHash(token));
    writePrivate(sessionFile(home), `${token}\n`);
  });
}
